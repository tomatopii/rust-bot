import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { describeError, type Logger } from '../logger.js';
import { alarmRouteFor, parseSettings, type AlarmMode, type SettingsStore } from '../settings.js';
import type { State } from '../state.js';
import type { EventHub } from './eventHub.js';

/** Web 画面がボット本体を触るための口。ここに無いものは画面から見えない */
export type WebServerDeps = Readonly<{
    hub: EventHub;
    settings: SettingsStore;
    getState: () => State;
    /** Discord にテスト投稿する */
    testPost: () => Promise<void>;
    /** 画面の HTML を読む */
    readPage: () => Promise<string>;
    log: Logger;
    forwards: Readonly<{ death: boolean; teamLogin: boolean }>;
    version: string;
}>;

/** 起動中の HTTP サーバー */
export type WebServer = Readonly<{
    /** 実際に待ち受けているポート（0 を渡したときに割り当てられた番号） */
    port: number;
    close(): Promise<void>;
}>;

// 自分の PC からだけ開ける画面にするため、待ち受けアドレスは設定で変えられないようにする
const BIND_HOST = '127.0.0.1';
// ブラウザが他のホスト名で引いた IP に誘導されても弾く（DNS rebinding 対策）
const ALLOWED_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];
const MAX_BODY_BYTES = 64 * 1024;
const SSE_PING_INTERVAL_MS = 15000;
const CONTENT_SECURITY_POLICY =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:";
const COMMON_HEADERS: Readonly<Record<string, string>> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
};

/** 画面の HTML を読む。開発時（src/web）でもビルド後（dist/web）でも同じ web/index.html に解決される */
export function readIndexPage(): Promise<string> {
    return readFile(join(__dirname, '../../web/index.html'), 'utf8');
}

/** Host ヘッダーのホスト名部分。IPv6 は括弧ごと取り出す */
function hostnameOf(host: string): string {
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        return end === -1 ? host : host.slice(0, end + 1);
    }
    const colon = host.indexOf(':');
    return colon === -1 ? host : host.slice(0, colon);
}

function isAllowedHost(host: string | undefined): boolean {
    return host !== undefined && ALLOWED_HOSTNAMES.includes(hostnameOf(host));
}

function isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    return url.protocol === 'http:' && ALLOWED_HOSTNAMES.includes(url.hostname);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...COMMON_HEADERS, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
    sendJson(res, status, { error: message });
}

type BodyResult = Readonly<{ ok: true; text: string }> | Readonly<{ ok: false }>;

/** 本文を上限まで読む。超えたら読むのをやめる（画面からの設定は数十 KB に収まる） */
async function readBody(req: IncomingMessage): Promise<BodyResult> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BODY_BYTES) return { ok: false };
        chunks.push(buffer);
    }
    return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

type AlarmView = Readonly<{
    title: string;
    mode: AlarmMode;
    mention: string | undefined;
    known: boolean;
    lastFiredAt: string | undefined;
    count: number;
}>;

/** 設定済みの題名と発報した題名の和集合を題名順に並べる */
function alarmViews(deps: WebServerDeps): readonly AlarmView[] {
    const settings = deps.settings.get();
    const state = deps.getState();
    const titles = [...new Set([...Object.keys(settings.alarms), ...Object.keys(state.alarmTitles)])];
    return titles
        .sort((left, right) => left.localeCompare(right, 'ja'))
        .map((title) => {
            const route = alarmRouteFor(settings, title);
            const fired = state.alarmTitles[title];
            return {
                title,
                mode: route.mode,
                mention: route.mention,
                known: route.known,
                lastFiredAt: fired?.lastFiredAt,
                count: fired?.count ?? 0,
            };
        });
}

type DeviceView = Readonly<{
    key: string;
    server: string;
    serverName: string;
    entityId: string;
    entityType: string;
    entityName: string;
    pairedAt: string;
}>;

/** ペアリング済みデバイスを新しい順に並べる。サーバー名はペアリング時に覚えた名前、無ければアドレス */
function deviceViews(state: State): readonly DeviceView[] {
    return Object.entries(state.entities)
        .map(([key, entity]) => ({ key, ...entity, serverName: state.servers[entity.server]?.name ?? entity.server }))
        .sort((left, right) => right.pairedAt.localeCompare(left.pairedAt));
}

function writeChunk(res: ServerResponse, chunk: string): void {
    if (res.writableEnded) return;
    try {
        res.write(chunk);
    } catch {
        // 切断直後の書き込みは失敗するが、close イベントで後始末するのでここでは捨てる
    }
}

/** SSE で画面につなぐ。戻り値を呼ぶと購読とタイマーを片付けて接続を終わらせる */
function startEventStream(res: ServerResponse, deps: WebServerDeps): () => void {
    res.writeHead(200, { ...COMMON_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    const snapshot = { events: deps.hub.recent(), status: deps.hub.status() };
    writeChunk(res, `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

    const unsubscribe = deps.hub.subscribe((event) => {
        writeChunk(res, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    // 途中の機器が無通信の接続を切るのを防ぐ。プロセスの終了を妨げないよう unref する
    const ping = setInterval(() => writeChunk(res, ': ping\n\n'), SSE_PING_INTERVAL_MS);
    ping.unref();

    let stopped = false;
    const stop = (): void => {
        if (stopped) return;
        stopped = true;
        clearInterval(ping);
        unsubscribe();
        res.end();
    };
    res.on('close', stop);
    // 切断時の EPIPE などで 'error' の購読者が居ないと落ちるので、後始末だけして無視する
    res.on('error', stop);
    return stop;
}

async function handleSettingsUpdate(req: IncomingMessage, res: ServerResponse, deps: WebServerDeps): Promise<void> {
    const body = await readBody(req);
    if (!body.ok) {
        sendError(res, 413, '設定が大きすぎます');
        return;
    }
    let json: unknown;
    try {
        json = JSON.parse(body.text);
    } catch {
        sendError(res, 400, 'JSON として読めません');
        return;
    }
    const parsed = parseSettings(json);
    if (!parsed.ok) {
        sendError(res, 400, parsed.reason);
        return;
    }
    await deps.settings.update(parsed.settings);
    sendJson(res, 200, deps.settings.get());
}

async function handleTestPost(res: ServerResponse, deps: WebServerDeps): Promise<void> {
    try {
        await deps.testPost();
    } catch (error) {
        const reason = describeError(error);
        deps.log.error(`テスト投稿に失敗しました: ${reason}`);
        sendError(res, 502, reason);
        return;
    }
    res.writeHead(204, COMMON_HEADERS);
    res.end();
}

/** 経路ごとの処理。戻り値は SSE の後始末（SSE 以外は undefined） */
async function route(
    req: IncomingMessage,
    res: ServerResponse,
    deps: WebServerDeps,
    path: string,
): Promise<(() => void) | undefined> {
    const method = req.method ?? 'GET';
    const get = (handler: () => Promise<void> | void): Promise<void> | void =>
        method === 'GET' ? handler() : sendError(res, 405, 'このメソッドは使えません');

    switch (path) {
        case '/':
            await get(async () => {
                const page = await deps.readPage();
                res.writeHead(200, {
                    ...COMMON_HEADERS,
                    'content-type': 'text/html; charset=utf-8',
                    'content-security-policy': CONTENT_SECURITY_POLICY,
                });
                res.end(page);
            });
            return undefined;
        case '/api/status':
            await get(() => sendJson(res, 200, { ...deps.hub.status(), forwards: deps.forwards, version: deps.version }));
            return undefined;
        case '/api/events':
            if (method !== 'GET') {
                sendError(res, 405, 'このメソッドは使えません');
                return undefined;
            }
            return startEventStream(res, deps);
        case '/api/alarms':
            await get(() => sendJson(res, 200, { titles: alarmViews(deps), devices: deviceViews(deps.getState()) }));
            return undefined;
        case '/api/settings':
            if (method === 'GET') {
                sendJson(res, 200, deps.settings.get());
                return undefined;
            }
            if (method === 'PUT') {
                await handleSettingsUpdate(req, res, deps);
                return undefined;
            }
            sendError(res, 405, 'このメソッドは使えません');
            return undefined;
        case '/api/test-post':
            if (method !== 'POST') {
                sendError(res, 405, 'このメソッドは使えません');
                return undefined;
            }
            await handleTestPost(res, deps);
            return undefined;
        default:
            sendError(res, 404, '見つかりません');
            return undefined;
    }
}

/** 画面用の HTTP サーバーを 127.0.0.1 で起動する。ポートに 0 を渡すと空きポートが割り当てられる */
export function startWebServer(port: number, deps: WebServerDeps): Promise<WebServer> {
    const streams = new Set<() => void>();
    const server = createServer((req, res) => {
        void (async (): Promise<void> => {
            if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
                sendError(res, 403, 'この画面は同じ PC からだけ開けます');
                return;
            }
            const method = req.method ?? 'GET';
            const contentType = req.headers['content-type'] ?? '';
            if (method !== 'GET' && !contentType.toLowerCase().startsWith('application/json')) {
                sendError(res, 415, 'Content-Type は application/json にしてください');
                return;
            }
            const path = new URL(req.url ?? '/', `http://${BIND_HOST}`).pathname;
            const stop = await route(req, res, deps, path);
            if (stop === undefined) return;
            streams.add(stop);
            res.on('close', () => void streams.delete(stop));
        })().catch((error: unknown) => {
            deps.log.error(`Web 画面の処理でエラーが起きました (${req.method ?? '-'} ${req.url ?? '-'}): ${describeError(error)}`);
            // 詳細はログにだけ残す（画面に出すとスタックや内部の値が漏れる）
            if (!res.headersSent) sendError(res, 500, '内部エラー');
            res.end();
        });
    });

    return new Promise<WebServer>((resolve, reject) => {
        let listening = false;
        server.on('error', (error: unknown) => {
            if (listening) {
                deps.log.error(`Web 画面のサーバーでエラーが起きました: ${describeError(error)}`);
                return;
            }
            reject(error instanceof Error ? error : new Error(describeError(error)));
        });
        server.listen(port, BIND_HOST, () => {
            listening = true;
            const address = server.address();
            resolve({
                port: typeof address === 'object' && address !== null ? address.port : port,
                close: async (): Promise<void> => {
                    for (const stop of [...streams]) stop();
                    streams.clear();
                    await new Promise<void>((done) => {
                        server.close(() => done());
                        // ブラウザも fetch も接続を使い回すので、切らないと close が終わらない。
                        // 終了処理の途中なので、残っているやり取りは打ち切ってよい
                        server.closeAllConnections();
                    });
                },
            });
        });
    });
}
