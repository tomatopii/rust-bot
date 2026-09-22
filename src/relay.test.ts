import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import type { WebhookPayload } from './discord/webhook.js';
import type { Logger } from './logger.js';
import { relayNotification, type RelayDeps } from './relay.js';
import { DEFAULT_SETTINGS, type Settings, type SettingsStore } from './settings.js';
import { EMPTY_STATE } from './state.js';
import type { HubEvent, HubEventInput, NotificationEvent } from './web/eventHub.js';

const config: Config = {
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/a',
    GCM_ANDROID_ID: '1',
    GCM_SECURITY_TOKEN: '2',
    ALARM_MENTION: '@here',
    FORWARD_DEATH: false,
    FORWARD_TEAM_LOGIN: false,
    STATE_FILE: 'state.json',
    SETTINGS_FILE: 'settings.json',
    WEB_PORT: 0,
};

const appData = (fields: Record<string, string>) => Object.entries(fields).map(([key, value]) => ({ key, value }));

const serverPairing = appData({
    title: 'My Server',
    message: 'Tap to pair',
    channelId: 'pairing',
    body: JSON.stringify({ type: 'server', name: 'My Server', ip: '1.2.3.4', port: '28083', playerId: '7', playerToken: '8' }),
});

const entityPairing = appData({
    title: 'My Server',
    message: 'Tap to pair',
    channelId: 'pairing',
    body: JSON.stringify({
        type: 'entity',
        name: 'My Server',
        ip: '1.2.3.4',
        port: '28083',
        entityId: '9',
        entityName: 'Smart Alarm',
        entityType: '1',
    }),
});

const alarm = appData({
    title: 'Front door',
    message: 'Someone is at the door!',
    channelId: 'alarm',
    body: JSON.stringify({ type: 'alarm', ip: '1.2.3.4', port: '28083', entityId: '9' }),
});

type DepsOptions = Readonly<{
    config?: Partial<Config>;
    postImpl?: (payload: WebhookPayload) => Promise<void>;
    settings?: Settings;
}>;

function createDeps(options: DepsOptions = {}) {
    const posted: WebhookPayload[] = [];
    const logs: string[] = [];
    const events: HubEvent[] = [];
    let settings = options.settings ?? DEFAULT_SETTINGS;
    let seq = 0;
    const log: Logger = {
        debug: (message) => void logs.push(`debug ${message}`),
        info: (message) => void logs.push(`info ${message}`),
        warn: (message) => void logs.push(`warn ${message}`),
        error: (message) => void logs.push(`error ${message}`),
    };
    const store: SettingsStore = {
        get: () => settings,
        update: (next) => {
            settings = next;
            return Promise.resolve();
        },
    };
    const deps: RelayDeps = {
        config: { ...config, ...options.config },
        log,
        post: async (payload) => {
            posted.push(payload);
            await options.postImpl?.(payload);
        },
        now: () => new Date('2026-09-22T03:00:00Z'),
        settings: store,
        hub: {
            publish: (input: HubEventInput) => {
                seq += 1;
                const event = { ...input, seq, time: '2026-09-22T03:00:00.000Z' } as HubEvent;
                events.push(event);
                return event;
            },
        },
    };
    return { deps, posted, logs, events, settings: () => settings };
}

function notifications(events: readonly HubEvent[]): readonly NotificationEvent[] {
    return events.filter((event): event is NotificationEvent => event.type === 'notification');
}

const settingsWith = (alarms: Settings['alarms'], unknownAlarmMode: Settings['unknownAlarmMode'] = 'discord'): Settings => ({
    version: 1,
    unknownAlarmMode,
    alarms,
});

describe('relayNotification', () => {
    it('アラームをメンション付きで投稿し、履歴と発報回数を残す', async () => {
        const { deps, posted, events } = createDeps();
        const state = await relayNotification(alarm, EMPTY_STATE, deps);
        expect(posted).toHaveLength(1);
        expect(posted[0]?.content).toBe('@here');
        expect(posted[0]?.allowed_mentions).toEqual({ parse: ['everyone'], roles: [], users: [] });
        expect(posted[0]?.embeds[0]?.title).toBe('Front door');
        expect(posted[0]?.embeds[0]?.fields[0]).toEqual({ name: 'サーバー', value: '1.2.3.4:28083', inline: true });
        expect(state.alarmTitles['Front door']).toEqual({ count: 1, lastFiredAt: '2026-09-22T03:00:00.000Z' });
        expect(notifications(events)).toMatchObject([{ kind: 'alarm', title: 'Front door', outcome: 'posted' }]);
    });

    it('未設定の題名を既定の振り分けで設定に登録する', async () => {
        const { deps, settings } = createDeps({ settings: settingsWith({}, 'log') });
        await relayNotification(alarm, EMPTY_STATE, deps);
        expect(settings().alarms['Front door']).toEqual({ mode: 'log' });
    });

    it('Object.prototype と同名の題名も未設定扱いで転送し、設定に登録する', async () => {
        const tricky = appData({
            title: 'toString',
            message: 'Someone is at the door!',
            channelId: 'alarm',
            body: JSON.stringify({ type: 'alarm', ip: '1.2.3.4', port: '28083' }),
        });
        const { deps, posted, events, settings } = createDeps();
        const state = await relayNotification(tricky, EMPTY_STATE, deps);
        expect(posted).toHaveLength(1);
        expect(notifications(events)).toMatchObject([{ kind: 'alarm', title: 'toString', outcome: 'posted' }]);
        expect(settings().alarms['toString']).toEqual({ mode: 'discord' });
        expect(state.alarmTitles['toString']).toEqual({ count: 1, lastFiredAt: '2026-09-22T03:00:00.000Z' });
    });

    it('ログだけの題名は投稿せず info で記録する', async () => {
        const { deps, posted, logs, events, settings } = createDeps({ settings: settingsWith({ 'Front door': { mode: 'log' } }) });
        await relayNotification(alarm, EMPTY_STATE, deps);
        expect(posted).toHaveLength(0);
        expect(logs.some((line) => line.startsWith('info') && line.includes('Front door'))).toBe(true);
        expect(notifications(events)).toMatchObject([{ outcome: 'logged' }]);
        // 登録済みの題名は上書きしない
        expect(settings().alarms['Front door']).toEqual({ mode: 'log' });
    });

    it('無視する題名は投稿もログも出さず、履歴にだけ残す', async () => {
        const { deps, posted, logs, events } = createDeps({ settings: settingsWith({ 'Front door': { mode: 'mute' } }) });
        await relayNotification(alarm, EMPTY_STATE, deps);
        expect(posted).toHaveLength(0);
        expect(logs.every((line) => line.startsWith('debug'))).toBe(true);
        expect(notifications(events)).toMatchObject([{ outcome: 'muted' }]);
    });

    it('題名ごとのメンションは ALARM_MENTION を上書きする', async () => {
        const { deps, posted } = createDeps({
            settings: settingsWith({ 'Front door': { mode: 'discord', mention: '<@&123>' } }),
        });
        await relayNotification(alarm, EMPTY_STATE, deps);
        expect(posted[0]?.content).toBe('<@&123>');
        expect(posted[0]?.allowed_mentions).toEqual({ parse: [], roles: ['123'], users: [] });
    });

    it('題名が空のアラームも 1 つの題名としてまとめる', async () => {
        const untitled = appData({ title: '  ', message: 'msg', channelId: 'alarm', body: JSON.stringify({ type: 'alarm' }) });
        const { deps, settings } = createDeps();
        const state = await relayNotification(untitled, EMPTY_STATE, deps);
        expect(Object.keys(settings().alarms)).toEqual(['(無題)']);
        expect(state.alarmTitles['(無題)']?.count).toBe(1);
    });

    it('アラーム本文にサーバー名があれば、覚えた名前が無くてもそれを出す', async () => {
        const named = appData({
            title: 'Front door',
            message: 'msg',
            channelId: 'alarm',
            body: JSON.stringify({ type: 'alarm', name: 'Body Server', ip: '1.2.3.4', port: '28083' }),
        });
        const { deps, posted, events } = createDeps();
        await relayNotification(named, EMPTY_STATE, deps);
        expect(posted[0]?.embeds[0]?.fields[0]).toEqual({ name: 'サーバー', value: 'Body Server', inline: true });
        expect(notifications(events)[0]?.server).toBe('Body Server');
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
        const { deps, posted, events } = createDeps();
        const paired = await relayNotification(serverPairing, EMPTY_STATE, deps);
        expect(paired.servers['1.2.3.4:28083']).toEqual({ name: 'My Server' });
        expect(posted).toHaveLength(0);
        expect(notifications(events)).toMatchObject([{ kind: 'pairing-server', outcome: 'paired' }]);

        await relayNotification(alarm, paired, deps);
        expect(posted[0]?.embeds[0]?.fields[0]).toEqual({ name: 'サーバー', value: 'My Server', inline: true });
    });

    it('デバイスのペアリングを記録し、履歴に残す', async () => {
        const { deps, posted, events } = createDeps();
        const paired = await relayNotification(entityPairing, EMPTY_STATE, deps);
        expect(posted).toHaveLength(0);
        expect(paired.entities['1.2.3.4:28083/9']).toEqual({
            server: '1.2.3.4:28083',
            entityId: '9',
            entityType: '1',
            entityName: 'Smart Alarm',
            pairedAt: '2026-09-22T03:00:00.000Z',
        });
        expect(notifications(events)).toMatchObject([
            { kind: 'pairing-entity', title: 'Smart Alarm', outcome: 'paired', detail: '9' },
        ]);
    });

    it('死亡とログインは設定で転送を切り替える', async () => {
        const death = appData({ title: 'Killed', message: 'by X', channelId: 'player', body: JSON.stringify({ type: 'death' }) });
        const off = createDeps();
        await relayNotification(death, EMPTY_STATE, off.deps);
        expect(off.posted).toHaveLength(0);
        expect(off.logs.some((line) => line.startsWith('debug'))).toBe(true);
        expect(notifications(off.events)).toMatchObject([{ kind: 'death', outcome: 'skipped' }]);

        const on = createDeps({ config: { FORWARD_DEATH: true } });
        await relayNotification(death, EMPTY_STATE, on.deps);
        expect(on.posted).toHaveLength(1);
        expect(on.posted[0]?.content).toBeUndefined();
        expect(notifications(on.events)).toMatchObject([{ kind: 'death', outcome: 'posted' }]);
    });

    it('投稿に失敗しても例外にせずログと履歴に残す', async () => {
        const { deps, logs, events } = createDeps({
            postImpl: async () => {
                throw new Error('boom');
            },
        });
        await expect(relayNotification(alarm, EMPTY_STATE, deps)).resolves.toMatchObject({ version: 1 });
        expect(logs.some((line) => line.startsWith('error') && line.includes('boom'))).toBe(true);
        expect(notifications(events)).toMatchObject([{ outcome: 'failed', detail: 'boom' }]);
    });

    it('未対応の通知は既定で表示されるレベル（info）で記録し、投稿しない', async () => {
        const news = appData({ title: 'News', message: 'Wipe today', channelId: 'news', body: JSON.stringify({ type: 'news' }) });
        const { deps, posted, logs, events } = createDeps();
        await relayNotification(news, EMPTY_STATE, deps);
        expect(posted).toHaveLength(0);
        expect(logs.some((line) => line.startsWith('info') && line.includes('channelId=news'))).toBe(true);
        expect(notifications(events)).toMatchObject([{ kind: 'unknown', outcome: 'ignored' }]);
    });

    it('読めない通知は警告して読み飛ばし、履歴には残さない', async () => {
        const { deps, posted, logs, events } = createDeps();
        await relayNotification('garbage', EMPTY_STATE, deps);
        expect(posted).toHaveLength(0);
        expect(logs.some((line) => line.startsWith('warn'))).toBe(true);
        expect(events).toEqual([]);
    });
});
