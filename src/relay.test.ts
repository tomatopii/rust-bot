import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import type { WebhookPayload } from './discord/webhook.js';
import type { Logger } from './logger.js';
import { relayNotification, type RelayDeps } from './relay.js';
import { EMPTY_STATE } from './state.js';

const config: Config = {
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/a',
    GCM_ANDROID_ID: '1',
    GCM_SECURITY_TOKEN: '2',
    ALARM_MENTION: '@here',
    FORWARD_DEATH: false,
    FORWARD_TEAM_LOGIN: false,
    STATE_FILE: 'state.json',
};

const appData = (fields: Record<string, string>) => Object.entries(fields).map(([key, value]) => ({ key, value }));

const serverPairing = appData({
    title: 'My Server',
    message: 'Tap to pair',
    channelId: 'pairing',
    body: JSON.stringify({ type: 'server', name: 'My Server', ip: '1.2.3.4', port: '28083', playerId: '7', playerToken: '8' }),
});

const alarm = appData({
    title: 'Front door',
    message: 'Someone is at the door!',
    channelId: 'alarm',
    body: JSON.stringify({ type: 'alarm', ip: '1.2.3.4', port: '28083', entityId: '9' }),
});

function createDeps(overrides: Partial<Config> = {}, postImpl?: (payload: WebhookPayload) => Promise<void>) {
    const posted: WebhookPayload[] = [];
    const logs: string[] = [];
    const log: Logger = {
        debug: (message) => void logs.push(`debug ${message}`),
        info: (message) => void logs.push(`info ${message}`),
        warn: (message) => void logs.push(`warn ${message}`),
        error: (message) => void logs.push(`error ${message}`),
    };
    const deps: RelayDeps = {
        config: { ...config, ...overrides },
        log,
        post: async (payload) => {
            posted.push(payload);
            await postImpl?.(payload);
        },
        now: () => new Date('2026-09-22T03:00:00Z'),
    };
    return { deps, posted, logs };
}

describe('relayNotification', () => {
    it('アラームをメンション付きで投稿する', async () => {
        const { deps, posted } = createDeps();
        const state = await relayNotification(alarm, EMPTY_STATE, deps);
        expect(state).toBe(EMPTY_STATE);
        expect(posted).toHaveLength(1);
        expect(posted[0]?.content).toBe('@here');
        expect(posted[0]?.allowed_mentions).toEqual({ parse: ['everyone'], roles: [], users: [] });
        expect(posted[0]?.embeds[0]?.title).toBe('Front door');
        expect(posted[0]?.embeds[0]?.fields[0]).toEqual({ name: 'サーバー', value: '1.2.3.4:28083', inline: true });
    });

    it('アラーム本文にサーバー名があれば、覚えた名前が無くてもそれを出す', async () => {
        const named = appData({
            title: 'Front door',
            message: 'msg',
            channelId: 'alarm',
            body: JSON.stringify({ type: 'alarm', name: 'Body Server', ip: '1.2.3.4', port: '28083' }),
        });
        const { deps, posted } = createDeps();
        await relayNotification(named, EMPTY_STATE, deps);
        expect(posted[0]?.embeds[0]?.fields[0]).toEqual({ name: 'サーバー', value: 'Body Server', inline: true });
    });

    it('覚えたサーバー名が空なら ip:port を出す（空のフィールド値を Discord に送らない）', async () => {
        const unnamed = appData({
            channelId: 'pairing',
            body: JSON.stringify({ type: 'server', name: '', ip: '1.2.3.4', port: '28083', playerId: '7' }),
        });
        const { deps, posted } = createDeps();
        const paired = await relayNotification(unnamed, EMPTY_STATE, deps);
        expect(paired.servers['1.2.3.4:28083']).toEqual({ name: '' });

        await relayNotification(alarm, paired, deps);
        expect(posted[0]?.embeds[0]?.fields[0]).toEqual({ name: 'サーバー', value: '1.2.3.4:28083', inline: true });
    });

    it('サーバーのペアリングで名前を覚え、以後のアラームに名前を出す', async () => {
        const { deps, posted } = createDeps();
        const paired = await relayNotification(serverPairing, EMPTY_STATE, deps);
        expect(paired.servers['1.2.3.4:28083']).toEqual({ name: 'My Server' });
        expect(posted).toHaveLength(0);

        await relayNotification(alarm, paired, deps);
        expect(posted[0]?.embeds[0]?.fields[0]).toEqual({ name: 'サーバー', value: 'My Server', inline: true });
    });

    it('死亡とログインは設定で転送を切り替える', async () => {
        const death = appData({ title: 'Killed', message: 'by X', channelId: 'player', body: JSON.stringify({ type: 'death' }) });
        const off = createDeps();
        await relayNotification(death, EMPTY_STATE, off.deps);
        expect(off.posted).toHaveLength(0);
        expect(off.logs.some((line) => line.startsWith('debug'))).toBe(true);

        const on = createDeps({ FORWARD_DEATH: true });
        await relayNotification(death, EMPTY_STATE, on.deps);
        expect(on.posted).toHaveLength(1);
        expect(on.posted[0]?.content).toBeUndefined();
    });

    it('投稿に失敗しても例外にせずログに残す', async () => {
        const { deps, logs } = createDeps({}, async () => {
            throw new Error('boom');
        });
        await expect(relayNotification(alarm, EMPTY_STATE, deps)).resolves.toBe(EMPTY_STATE);
        expect(logs.some((line) => line.startsWith('error') && line.includes('boom'))).toBe(true);
    });

    it('読めない通知は警告して読み飛ばす', async () => {
        const { deps, posted, logs } = createDeps();
        await relayNotification('garbage', EMPTY_STATE, deps);
        expect(posted).toHaveLength(0);
        expect(logs.some((line) => line.startsWith('warn'))).toBe(true);
    });
});
