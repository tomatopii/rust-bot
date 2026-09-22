import { z } from 'zod';
import { describeIssues } from '../describeIssues.js';

/** FCM の appData は key/value の配列。Rust+ は title / message / channelId / body(JSON 文字列) を入れてくる */
const appDataSchema = z.array(z.object({ key: z.string(), value: z.string() }));

// Rust+ は数値項目も文字列で送ってくるので、数値だけ文字列にそろえる。
// z.coerce.string() は値が無くても String(undefined) === 'undefined' を通してしまうので使わない
const stringish = z
    .union([z.string(), z.number()], { error: '文字列か数値が必要です' })
    .transform((value) => String(value));

const serverBodySchema = z.object({
    name: z.string().default(''),
    ip: z.string().min(1),
    port: stringish,
    playerId: stringish,
});

const entityBodySchema = z.object({
    name: z.string().default(''),
    ip: z.string().min(1),
    port: stringish,
    entityId: stringish,
    entityName: z.string().default(''),
    entityType: stringish.default(''),
});

// アラームの付随情報（サーバー名やアドレス）は無くても投稿できるので、形式が違っても弾かずに捨てる
const alarmBodySchema = z.object({
    name: z.string().catch(''),
    ip: z.string().optional().catch(undefined),
    port: stringish.optional().catch(undefined),
    entityId: stringish.optional().catch(undefined),
});

export type ServerAddress = Readonly<{ ip: string; port: string }>;

export type Notification =
    | Readonly<{
          kind: 'alarm';
          title: string;
          message: string;
          serverName?: string;
          server?: ServerAddress;
          entityId?: string;
      }>
    | Readonly<{ kind: 'pairing-server'; serverName: string; server: ServerAddress; playerId: string }>
    | Readonly<{
          kind: 'pairing-entity';
          serverName: string;
          server: ServerAddress;
          entityId: string;
          entityName: string;
          entityType: string;
      }>
    | Readonly<{ kind: 'death'; title: string; message: string }>
    | Readonly<{ kind: 'team-login'; title: string; message: string }>
    | Readonly<{ kind: 'unknown'; channelId: string; bodyType: string | undefined; title: string; message: string }>;

export type ParseResult =
    | Readonly<{ ok: true; notification: Notification }>
    | Readonly<{ ok: false; reason: string }>;

type Body = Readonly<Record<string, unknown>>;
type BodyResult = Readonly<{ ok: true; body: Body }> | Readonly<{ ok: false; reason: string }>;

function ok(notification: Notification): ParseResult {
    return { ok: true, notification };
}

function parseBody(raw: string | undefined): BodyResult {
    if (raw === undefined) return { ok: true, body: {} };
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { ok: false, reason: 'body が JSON オブジェクトではない' };
        }
        return { ok: true, body: parsed as Body };
    } catch {
        return { ok: false, reason: 'body が JSON として読めない' };
    }
}

function parsePairing(body: Body, bodyType: string | undefined, title: string, message: string): ParseResult {
    if (bodyType === 'server') {
        const parsed = serverBodySchema.safeParse(body);
        if (!parsed.success) {
            return { ok: false, reason: `サーバーのペアリング通知の形式が想定と違う: ${describeIssues(parsed.error).join(', ')}` };
        }
        return ok({
            kind: 'pairing-server',
            serverName: parsed.data.name || title,
            server: { ip: parsed.data.ip, port: parsed.data.port },
            playerId: parsed.data.playerId,
        });
    }
    if (bodyType === 'entity') {
        const parsed = entityBodySchema.safeParse(body);
        if (!parsed.success) {
            return { ok: false, reason: `デバイスのペアリング通知の形式が想定と違う: ${describeIssues(parsed.error).join(', ')}` };
        }
        return ok({
            kind: 'pairing-entity',
            serverName: parsed.data.name || title,
            server: { ip: parsed.data.ip, port: parsed.data.port },
            entityId: parsed.data.entityId,
            entityName: parsed.data.entityName,
            entityType: parsed.data.entityType,
        });
    }
    return ok({ kind: 'unknown', channelId: 'pairing', bodyType, title, message });
}

function parseAlarm(body: Body, title: string, message: string): ParseResult {
    const parsed = alarmBodySchema.safeParse(body);
    if (!parsed.success) {
        return { ok: false, reason: `アラーム通知の形式が想定と違う: ${describeIssues(parsed.error).join(', ')}` };
    }
    const { name, ip, port, entityId } = parsed.data;
    // umod の raid-alarm プラグインは body.type を付けずに channelId=alarm で送ってくるので、type は見ない
    return ok({
        kind: 'alarm',
        title,
        message,
        ...(name !== '' ? { serverName: name } : {}),
        ...(ip !== undefined && ip !== '' && port !== undefined ? { server: { ip, port } } : {}),
        ...(entityId !== undefined && entityId !== '' ? { entityId } : {}),
    });
}

/** FCM で届いた appData を、種類ごとに型の付いた通知に変換する。形式が想定と違うときは reason を返す */
export function parseNotification(appData: unknown): ParseResult {
    const entries = appDataSchema.safeParse(appData);
    if (!entries.success) return { ok: false, reason: 'appData が key/value の配列ではない' };

    const fields = new Map(entries.data.map((entry) => [entry.key, entry.value] as const));
    const title = fields.get('title') ?? '';
    const message = fields.get('message') ?? '';
    const channelId = fields.get('channelId');
    if (channelId === undefined || channelId === '') return { ok: false, reason: 'channelId がない' };

    const body = parseBody(fields.get('body'));
    if (!body.ok) return body;
    const bodyType = typeof body.body['type'] === 'string' ? body.body['type'] : undefined;

    switch (channelId) {
        case 'pairing':
            return parsePairing(body.body, bodyType, title, message);
        case 'alarm':
            return parseAlarm(body.body, title, message);
        case 'player':
            if (bodyType === 'death') return ok({ kind: 'death', title, message });
            break;
        case 'team':
            if (bodyType === 'login') return ok({ kind: 'team-login', title, message });
            break;
        default:
            break;
    }
    return ok({ kind: 'unknown', channelId, bodyType, title, message });
}
