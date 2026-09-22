import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Logger } from './logger.js';
import type { Notification, ServerAddress } from './notification/parse.js';

// 受信済み ID は FCM の再送を見分けるためだけに使うので、古いものから捨てる
const MAX_PERSISTENT_IDS = 500;

// 後から増やした項目は .default() を付け、古い state.json をそのまま読めるようにする（version は 1 のまま）
const stateSchema = z.object({
    version: z.literal(1),
    persistentIds: z.array(z.string()).default([]),
    servers: z.record(z.string(), z.object({ name: z.string() })).default({}),
    entities: z
        .record(
            z.string(),
            z.object({
                server: z.string(),
                entityId: z.string(),
                entityType: z.string(),
                entityName: z.string(),
                pairedAt: z.string(),
            }),
        )
        .default({}),
    alarmTitles: z.record(z.string(), z.object({ lastFiredAt: z.string(), count: z.number() })).default({}),
});

export type State = Readonly<z.infer<typeof stateSchema>>;

/** ペアリングで届いたデバイスの通知 */
export type PairingEntityNotification = Extract<Notification, { kind: 'pairing-entity' }>;

export const EMPTY_STATE: State = { version: 1, persistentIds: [], servers: {}, entities: {}, alarmTitles: {} };

function isNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** state ファイルを読む。無ければ初期状態、壊れていれば警告して初期状態にする */
export async function loadState(path: string, log: Pick<Logger, 'warn'>): Promise<State> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if (isNotFound(error)) return EMPTY_STATE;
        throw error;
    }

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        log.warn(`${path} が JSON として読めないので初期化します`);
        return EMPTY_STATE;
    }
    const parsed = stateSchema.safeParse(json);
    if (!parsed.success) {
        log.warn(`${path} の形式が想定と違うので初期化します`);
        return EMPTY_STATE;
    }
    return parsed.data;
}

/** state ファイルを書く。書き込み途中で落ちても壊れたファイルが残らないよう、一時ファイルを書いてから置き換える */
export async function saveState(path: string, state: State): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmpPath, path);
}

/** 受信済み ID を追加した新しい state を返す（上限を超えた分は古い順に捨てる） */
export function rememberPersistentId(state: State, id: string): State {
    if (state.persistentIds.includes(id)) return state;
    return { ...state, persistentIds: [...state.persistentIds, id].slice(-MAX_PERSISTENT_IDS) };
}

/** サーバー名を覚えた新しい state を返す。アラーム通知には ip と port しか無いので、ペアリング時の名前を引けるようにする */
export function rememberServer(state: State, server: ServerAddress, name: string): State {
    return { ...state, servers: { ...state.servers, [serverKey(server)]: { name } } };
}

/** servers の添字。ip:port の形 */
export function serverKey(server: ServerAddress): string {
    return `${server.ip}:${server.port}`;
}

/** entities の添字。同じ ID でもサーバーが違えば別のデバイスなので、アドレスと組にする */
export function entityKey(server: ServerAddress, entityId: string): string {
    return `${serverKey(server)}/${entityId}`;
}

/** ペアリングしたデバイスを覚えた新しい state を返す。同じデバイスの再ペアリングは上書きする */
export function rememberEntity(state: State, notification: PairingEntityNotification, now: Date): State {
    const entity = {
        server: serverKey(notification.server),
        entityId: notification.entityId,
        entityType: notification.entityType,
        entityName: notification.entityName,
        pairedAt: now.toISOString(),
    };
    return { ...state, entities: { ...state.entities, [entityKey(notification.server, notification.entityId)]: entity } };
}

/** 題名ごとの発報回数と最終発報時刻を更新した新しい state を返す */
export function rememberAlarmFired(state: State, titleKey: string, now: Date): State {
    const count = (state.alarmTitles[titleKey]?.count ?? 0) + 1;
    return { ...state, alarmTitles: { ...state.alarmTitles, [titleKey]: { lastFiredAt: now.toISOString(), count } } };
}
