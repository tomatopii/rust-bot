import { describe, expect, it } from 'vitest';
import { allowedMentionsFor, buildPayload, EMBED_LIMITS, postWebhook, type FetchLike, type WebhookPayload } from './webhook.js';

const now = new Date('2026-09-22T03:00:00Z');

describe('buildPayload', () => {
    it('アラームを赤い embed にし、メンションは content に置く', () => {
        const payload = buildPayload(
            { kind: 'alarm', title: 'Front door', message: 'Someone is at the door!', server: { ip: '1.2.3.4', port: '28083' } },
            { mention: '@here', serverLabel: 'My Server', now },
        );
        expect(payload.content).toBe('@here');
        expect(payload.allowed_mentions).toEqual({ parse: ['everyone'], roles: [], users: [] });
        expect(payload.embeds).toHaveLength(1);
        const embed = payload.embeds[0];
        expect(embed?.title).toBe('Front door');
        expect(embed?.description).toBe('Someone is at the door!');
        expect(embed?.color).toBe(0xe74c3c);
        expect(embed?.fields).toEqual([
            { name: 'サーバー', value: 'My Server', inline: true },
            { name: '時刻', value: `<t:${Math.floor(now.getTime() / 1000)}:F>`, inline: true },
        ]);
        expect(embed?.timestamp).toBe(now.toISOString());
    });

    it('メンションが空なら content を付けず、誰も鳴らさない', () => {
        const payload = buildPayload({ kind: 'death', title: '', message: '' }, { mention: '  ', serverLabel: undefined, now });
        expect(payload.content).toBeUndefined();
        expect(payload.allowed_mentions).toEqual({ parse: [], roles: [], users: [] });
        expect(payload.embeds[0]?.title).toBe('倒されました');
        expect(payload.embeds[0]?.description).toBeUndefined();
        expect(payload.embeds[0]?.fields).toHaveLength(1);
    });

    it('空白だけのサーバー名はフィールドに出さない（Discord が空の値を拒否するため）', () => {
        const payload = buildPayload({ kind: 'alarm', title: 'x', message: '' }, { mention: '', serverLabel: '   ', now });
        expect(payload.embeds[0]?.fields).toEqual([{ name: '時刻', value: `<t:${Math.floor(now.getTime() / 1000)}:F>`, inline: true }]);
    });

    it('通知の文言に含まれるメンション記法では誰も鳴らさない', () => {
        const payload = buildPayload(
            { kind: 'alarm', title: '@everyone raid', message: '<@&999> <@1> @here' },
            { mention: '', serverLabel: undefined, now },
        );
        expect(payload.content).toBeUndefined();
        expect(payload.allowed_mentions).toEqual({ parse: [], roles: [], users: [] });
        expect(payload.embeds[0]?.title).toBe('@everyone raid');
        expect(payload.embeds[0]?.description).toBe('<@&999> <@1> @here');
    });

    it('鳴らす対象は設定したメンションだけで、通知の文言を足さない', () => {
        const payload = buildPayload(
            { kind: 'alarm', title: '@everyone raid', message: '<@&999> <@1>' },
            { mention: '<@&5>', serverLabel: undefined, now },
        );
        expect(payload.content).toBe('<@&5>');
        expect(payload.allowed_mentions).toEqual({ parse: [], roles: ['5'], users: [] });
    });

    it('長い題名と本文は Discord の上限に収める', () => {
        const payload = buildPayload(
            { kind: 'alarm', title: 'a'.repeat(300), message: 'b'.repeat(5000) },
            { mention: '', serverLabel: undefined, now },
        );
        expect(payload.embeds[0]?.title).toHaveLength(EMBED_LIMITS.title);
        expect(payload.embeds[0]?.title.endsWith('…')).toBe(true);
        expect(payload.embeds[0]?.description).toHaveLength(EMBED_LIMITS.description);
    });
});

describe('allowedMentionsFor', () => {
    it('ロール・ユーザー・@here を見分ける', () => {
        expect(allowedMentionsFor('<@&123> <@456> <@!789> @here')).toEqual({
            parse: ['everyone'],
            roles: ['123'],
            users: ['456', '789'],
        });
        expect(allowedMentionsFor('raid!')).toEqual({ parse: [], roles: [], users: [] });
    });
});

type FakeResponse = Readonly<{ status: number; body?: string }>;

function createFetch(responses: readonly FakeResponse[]) {
    const remaining = [...responses];
    const calls: { url: string; body: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
        calls.push({ url, body: init.body });
        const response = remaining.shift() ?? { status: 500 };
        return { status: response.status, text: async () => response.body ?? '' };
    };
    return { fetchImpl, calls };
}

const payload: WebhookPayload = { embeds: [], allowed_mentions: { parse: [], roles: [], users: [] } };
const url = 'https://discord.com/api/webhooks/1/a';

describe('postWebhook', () => {
    it('2xx なら 1 回で終わる', async () => {
        const { fetchImpl, calls } = createFetch([{ status: 204 }]);
        await postWebhook(url, payload, { fetchImpl });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(url);
        expect(JSON.parse(calls[0]?.body ?? '')).toEqual(payload);
    });

    it('429 は retry_after 秒だけ待って再試行する', async () => {
        const { fetchImpl, calls } = createFetch([{ status: 429, body: JSON.stringify({ retry_after: 1.5 }) }, { status: 204 }]);
        const waits: number[] = [];
        await postWebhook(url, payload, { fetchImpl, sleepImpl: async (ms) => void waits.push(ms) });
        expect(calls).toHaveLength(2);
        expect(waits).toEqual([1500]);
    });

    it.each([
        ['本文が HTML（Cloudflare 経由）', '<html>error 1015</html>'],
        ['retry_after が無い JSON', '{"message":"You are being rate limited."}'],
        ['本文が空', ''],
    ])('429 で %s なら既定の 5 秒だけ待って再試行する', async (_label, body) => {
        const { fetchImpl, calls } = createFetch([{ status: 429, body }, { status: 204 }]);
        const waits: number[] = [];
        await postWebhook(url, payload, { fetchImpl, sleepImpl: async (ms) => void waits.push(ms) });
        expect(calls).toHaveLength(2);
        expect(waits).toEqual([5000]);
    });

    it('5xx は回数上限まで再試行してから失敗する（最後の試行の後は待たない）', async () => {
        const { fetchImpl, calls } = createFetch([{ status: 500 }, { status: 502 }, { status: 503 }]);
        const waits: number[] = [];
        await expect(postWebhook(url, payload, { fetchImpl, sleepImpl: async (ms) => void waits.push(ms) })).rejects.toThrow(/503/);
        expect(calls).toHaveLength(3);
        expect(waits).toEqual([2000, 4000]);
    });

    it('接続に失敗したら待って再試行する', async () => {
        let attempts = 0;
        const fetchImpl: FetchLike = async () => {
            attempts += 1;
            if (attempts === 1) throw new TypeError('fetch failed');
            return { status: 204, text: async () => '' };
        };
        const waits: number[] = [];
        await postWebhook(url, payload, { fetchImpl, sleepImpl: async (ms) => void waits.push(ms) });
        expect(attempts).toBe(2);
        expect(waits).toEqual([2000]);
    });

    it('接続失敗が続けば理由つきで失敗する', async () => {
        const fetchImpl: FetchLike = async () => {
            throw new TypeError('fetch failed');
        };
        const waits: number[] = [];
        await expect(postWebhook(url, payload, { fetchImpl, sleepImpl: async (ms) => void waits.push(ms) })).rejects.toThrow(
            /接続できませんでした.*fetch failed/,
        );
        expect(waits).toEqual([2000, 4000]);
    });

    it('4xx は再試行せずに失敗する', async () => {
        const { fetchImpl, calls } = createFetch([{ status: 400, body: '{"message":"Invalid Form Body"}' }]);
        await expect(postWebhook(url, payload, { fetchImpl })).rejects.toThrow(/400/);
        expect(calls).toHaveLength(1);
    });
});
