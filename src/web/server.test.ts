import { request, type ClientRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings, type SettingsStore } from '../settings.js';
import { EMPTY_STATE, type State } from '../state.js';
import { createEventHub, type EventHub } from './eventHub.js';
import { readIndexPage, startWebServer, type WebServer, type WebServerDeps } from './server.js';

const logs: string[] = [];
const log = {
    debug: (message: string) => void logs.push(`debug ${message}`),
    info: (message: string) => void logs.push(`info ${message}`),
    warn: (message: string) => void logs.push(`warn ${message}`),
    error: (message: string) => void logs.push(`error ${message}`),
};

const state: State = {
    ...EMPTY_STATE,
    servers: { '1.2.3.4:28082': { name: 'テストサーバー' } },
    entities: {
        '1.2.3.4:28082/1': {
            server: '1.2.3.4:28082',
            entityId: '1',
            entityType: '1',
            entityName: 'Smart Alarm',
            pairedAt: '2026-09-21T00:00:00.000Z',
        },
        '5.6.7.8:28082/2': {
            server: '5.6.7.8:28082',
            entityId: '2',
            entityType: '2',
            entityName: 'Smart Switch',
            pairedAt: '2026-09-22T00:00:00.000Z',
        },
    },
    alarmTitles: { 玄関: { lastFiredAt: '2026-09-22T01:00:00.000Z', count: 3 } },
};

function createStore(initial: Settings): SettingsStore {
    let current = initial;
    return {
        get: () => current,
        update: (next) => {
            current = next;
            return Promise.resolve();
        },
        flush: () => Promise.resolve(),
    };
}

let server: WebServer | undefined;
let base = '';
let store: SettingsStore = createStore(DEFAULT_SETTINGS);
let hub: EventHub = createEventHub();

async function start(overrides: Partial<WebServerDeps> = {}): Promise<void> {
    logs.length = 0;
    hub = createEventHub();
    store = createStore(DEFAULT_SETTINGS);
    const deps: WebServerDeps = {
        hub,
        settings: store,
        getState: () => state,
        testPost: () => Promise.resolve(),
        readPage: () => Promise.resolve('<!doctype html><title>rust-bot</title>'),
        log,
        forwards: { death: false, teamLogin: true },
        version: '1.2.3',
        ...overrides,
    };
    server = await startWebServer(0, deps);
    base = `http://127.0.0.1:${server.port}`;
}

const json = { 'content-type': 'application/json' } as const;

// fetch では Host / Origin を差し替えられないので、検査のテストだけ node:http で送る
function rawGet(path: string, headers: Readonly<Record<string, string>>): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: server?.port, path, method: 'GET', headers }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
    });
}

// SSE は本文が終わらないので、最初のチャンクが届いた時点の要求を返す（呼び出し側が destroy して切断を作る）
function openEventStream(): Promise<ClientRequest> {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: server?.port, path: '/api/events', method: 'GET' }, (res) => {
            res.once('data', () => resolve(req));
        });
        req.on('error', reject);
        req.end();
    });
}

afterEach(async () => {
    await server?.close();
    server = undefined;
});

describe('startWebServer', () => {
    it('GET /api/status が状態と設定の要約を返す', async () => {
        await start();
        hub.publish({ type: 'status', fcm: 'connected' });
        const response = await fetch(`${base}/api/status`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        const body: unknown = await response.json();
        expect(body).toMatchObject({ fcm: 'connected', version: '1.2.3', forwards: { death: false, teamLogin: true } });
    });

    it('GET / は readPage の HTML を CSP 付きで返す', async () => {
        await start();
        const response = await fetch(`${base}/`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
        expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        expect(await response.text()).toContain('rust-bot');
    });

    it('Host が 127.0.0.1 でなければ 403 にする', async () => {
        await start();
        await expect(rawGet('/api/status', { host: 'evil.example.com' })).resolves.toBe(403);
        await expect(rawGet('/api/status', { host: `127.0.0.1:${server?.port ?? 0}` })).resolves.toBe(200);
        await expect(rawGet('/api/status', { host: '[::1]:8080' })).resolves.toBe(200);
    });

    it('別オリジンからの要求を 403 にする', async () => {
        await start();
        await expect(rawGet('/api/status', { origin: 'http://evil.example.com' })).resolves.toBe(403);
        await expect(rawGet('/api/status', { origin: 'https://127.0.0.1' })).resolves.toBe(403);
        await expect(rawGet('/api/status', { origin: `http://localhost:${server?.port ?? 0}` })).resolves.toBe(200);
    });

    it('GET 以外で Content-Type が JSON でなければ 415 にする', async () => {
        await start();
        const response = await fetch(`${base}/api/settings`, { method: 'PUT', body: '{}' });
        expect(response.status).toBe(415);
    });

    it('知らない経路は 404、メソッド違いは 405 にする', async () => {
        await start();
        expect((await fetch(`${base}/api/nope`)).status).toBe(404);
        expect((await fetch(`${base}/api/status`, { method: 'PUT', headers: json, body: '{}' })).status).toBe(405);
    });

    it('GET /api/alarms が題名と機器を並べる', async () => {
        await start();
        await store.update({ version: 1, unknownAlarmMode: 'log', alarms: { 裏口: { mode: 'mute' } } });
        const response = await fetch(`${base}/api/alarms`);
        const body = (await response.json()) as {
            titles: readonly { title: string; mode: string; known: boolean; count: number }[];
            devices: readonly { key: string; serverName: string }[];
        };
        expect(body.titles).toEqual([
            { title: '玄関', mode: 'log', mention: undefined, known: false, lastFiredAt: '2026-09-22T01:00:00.000Z', count: 3 },
            { title: '裏口', mode: 'mute', mention: undefined, known: true, lastFiredAt: undefined, count: 0 },
        ]);
        expect(body.devices.map((device) => device.key)).toEqual(['5.6.7.8:28082/2', '1.2.3.4:28082/1']);
        expect(body.devices[1]?.serverName).toBe('テストサーバー');
    });

    it('GET /api/alarms はサーバー名が空白だけならアドレスを出す', async () => {
        const blank: State = {
            ...EMPTY_STATE,
            servers: { '1.2.3.4:28082': { name: '  ' } },
            entities: {
                '1.2.3.4:28082/1': {
                    server: '1.2.3.4:28082',
                    entityId: '1',
                    entityType: '1',
                    entityName: 'Smart Alarm',
                    pairedAt: '2026-09-21T00:00:00.000Z',
                },
            },
        };
        await start({ getState: () => blank });
        const response = await fetch(`${base}/api/alarms`);
        const body = (await response.json()) as { devices: readonly { serverName: string }[] };
        expect(body.devices[0]?.serverName).toBe('1.2.3.4:28082');
    });

    it('GET /api/alarms は Object.prototype と同名の題名も未設定として出す', async () => {
        const fired: State = { ...EMPTY_STATE, alarmTitles: { toString: { lastFiredAt: '2026-09-22T01:00:00.000Z', count: 1 } } };
        await start({ getState: () => fired });
        const response = await fetch(`${base}/api/alarms`);
        const body = (await response.json()) as { titles: readonly Record<string, unknown>[] };
        expect(body.titles).toEqual([
            { title: 'toString', mode: 'discord', mention: undefined, known: false, lastFiredAt: '2026-09-22T01:00:00.000Z', count: 1 },
        ]);
    });

    it('PUT /api/settings は検証に通った設定を保存する', async () => {
        await start();
        const settings = { version: 1, unknownAlarmMode: 'mute', alarms: { 玄関: { mode: 'discord', mention: '@here' } } };
        const response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: json, body: JSON.stringify(settings) });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(settings);
        expect(store.get()).toEqual(settings);
    });

    it('PUT /api/settings は形式違いを 400 にする', async () => {
        await start();
        const response = await fetch(`${base}/api/settings`, {
            method: 'PUT',
            headers: json,
            body: JSON.stringify({ version: 1, unknownAlarmMode: 'x', alarms: {} }),
        });
        expect(response.status).toBe(400);
        expect((await response.json()) as { error: string }).toHaveProperty('error');
        expect(store.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('PUT /api/settings は JSON でない本文を 400 にする', async () => {
        await start();
        const response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: json, body: 'not json' });
        expect(response.status).toBe(400);
    });

    it('PUT /api/settings は上限を超える本文を 413 にして設定を変えない', async () => {
        await start();
        const body = `{"version":1,"unknownAlarmMode":"${'x'.repeat(70 * 1024)}"}`;
        const response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: json, body });
        expect(response.status).toBe(413);
        expect(store.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('POST /api/test-post は成功で 204、失敗で 502 にする', async () => {
        await start();
        expect((await fetch(`${base}/api/test-post`, { method: 'POST', headers: json })).status).toBe(204);
        await server?.close();
        await start({ testPost: () => Promise.reject(new Error('Discord が応答しません')) });
        const response = await fetch(`${base}/api/test-post`, { method: 'POST', headers: json });
        expect(response.status).toBe(502);
        expect((await response.json()) as { error: string }).toEqual({ error: 'Discord が応答しません' });
        expect(logs.some((line) => line.startsWith('error '))).toBe(true);
    });

    it('GET /api/events は snapshot から始めて以後のイベントを流す', async () => {
        await start();
        hub.publish({ type: 'log', level: 'info', message: '起動しました' });
        const response = await fetch(`${base}/api/events`);
        expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
        const reader = response.body?.getReader();
        if (reader === undefined) throw new Error('SSE の本文が取れません');
        const decoder = new TextDecoder();

        const first = decoder.decode((await reader.read()).value);
        expect(first).toContain('event: snapshot');
        expect(first).toContain('起動しました');

        hub.publish({ type: 'notification', kind: 'alarm', title: '玄関', message: '発報', outcome: 'posted' });
        const next = decoder.decode((await reader.read()).value);
        expect(next).toContain('event: notification');
        expect(next).toContain('玄関');
        await reader.cancel();
    });

    it('ブラウザが切断したら購読と ping タイマーを片付ける', async () => {
        const source = createEventHub();
        let subscribers = 0;
        const counting: EventHub = {
            ...source,
            subscribe: (listener) => {
                subscribers += 1;
                const unsubscribe = source.subscribe(listener);
                return () => {
                    subscribers -= 1;
                    unsubscribe();
                };
            },
        };
        const clearSpy = vi.spyOn(globalThis, 'clearInterval');
        try {
            await start({ hub: counting });
            const req = await openEventStream();
            expect(subscribers).toBe(1);

            req.destroy();
            await vi.waitFor(() => expect(subscribers).toBe(0));
            expect(clearSpy).toHaveBeenCalled();
        } finally {
            clearSpy.mockRestore();
        }
    });

    it('ハンドラの例外は詳細を返さず 500 にする', async () => {
        await start({ readPage: () => Promise.reject(new Error('secret-path が読めません')) });
        const response = await fetch(`${base}/`);
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain('secret-path');
        expect(logs.some((line) => line.includes('secret-path'))).toBe(true);
    });

    it('close すると接続中の SSE ごと終了する', async () => {
        await start();
        const response = await fetch(`${base}/api/events`);
        const reader = response.body?.getReader();
        if (reader === undefined) throw new Error('SSE の本文が取れません');
        await reader.read();

        const closing = server?.close();
        server = undefined;
        await expect(closing).resolves.toBeUndefined();
        await expect(fetch(`${base}/api/status`)).rejects.toThrow();
    });
});

describe('readIndexPage', () => {
    it('リポジトリの web/index.html を読める', async () => {
        const page = await readIndexPage();
        expect(page).toContain('<title>rust-bot');
    });
});
