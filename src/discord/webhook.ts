import { setTimeout as sleep } from 'node:timers/promises';
import { describeError } from '../logger.js';
import type { Notification } from '../notification/parse.js';

/** Discord の embed の文字数上限（https://discord.com/developers/docs/resources/message#embed-object-embed-limits） */
export const EMBED_LIMITS = { title: 256, description: 4096, fieldValue: 1024 } as const;

const ALARM_COLOR = 0xe74c3c;
const INFO_COLOR = 0x3498db;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;
const DEFAULT_RETRY_AFTER_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;

export type PostableNotification = Extract<Notification, { kind: 'alarm' | 'death' | 'team-login' }>;

const DEFAULT_TITLES: Readonly<Record<PostableNotification['kind'], string>> = {
    alarm: 'スマートアラーム',
    death: '倒されました',
    'team-login': 'チームメイトがログイン',
};

const FOOTERS: Readonly<Record<PostableNotification['kind'], string>> = {
    alarm: 'Rust+ スマートアラーム',
    death: 'Rust+ 死亡通知',
    'team-login': 'Rust+ チーム',
};

export type Embed = Readonly<{
    title: string;
    description?: string;
    color: number;
    fields: readonly Readonly<{ name: string; value: string; inline: boolean }>[];
    footer: Readonly<{ text: string }>;
    timestamp: string;
}>;

export type AllowedMentions = Readonly<{
    parse: readonly ('everyone' | 'roles' | 'users')[];
    roles: readonly string[];
    users: readonly string[];
}>;

export type WebhookPayload = Readonly<{
    content?: string;
    embeds: readonly Embed[];
    allowed_mentions: AllowedMentions;
}>;

export type BuildOptions = Readonly<{
    mention: string;
    serverLabel: string | undefined;
    now: Date;
}>;

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** メンション文字列に含まれる対象だけを鳴らす。embed に入るゲーム由来の文言は content に入れないので鳴らない */
export function allowedMentionsFor(mention: string): AllowedMentions {
    const roles = [...mention.matchAll(/<@&(\d+)>/g)].map((match) => match[1]).filter((id): id is string => id !== undefined);
    const users = [...mention.matchAll(/<@!?(\d+)>/g)].map((match) => match[1]).filter((id): id is string => id !== undefined);
    const parse: AllowedMentions['parse'] = /@(here|everyone)\b/.test(mention) ? ['everyone'] : [];
    return { parse, roles, users };
}

/** 通知 1 件を Discord Webhook に送る JSON にする */
export function buildPayload(notification: PostableNotification, options: BuildOptions): WebhookPayload {
    const unixSeconds = Math.floor(options.now.getTime() / 1000);
    // Discord はフィールド値が空だと 400 を返すので、空白だけのサーバー名は無い物として扱う
    const serverLabel = options.serverLabel?.trim();
    const fields = [
        ...(serverLabel !== undefined && serverLabel !== ''
            ? [{ name: 'サーバー', value: truncate(serverLabel, EMBED_LIMITS.fieldValue), inline: true }]
            : []),
        { name: '時刻', value: `<t:${unixSeconds}:F>`, inline: true },
    ];
    const description = truncate(notification.message.trim(), EMBED_LIMITS.description);
    const embed: Embed = {
        title: truncate(notification.title.trim() || DEFAULT_TITLES[notification.kind], EMBED_LIMITS.title),
        ...(description !== '' ? { description } : {}),
        color: notification.kind === 'alarm' ? ALARM_COLOR : INFO_COLOR,
        fields,
        footer: { text: FOOTERS[notification.kind] },
        timestamp: options.now.toISOString(),
    };
    const mention = options.mention.trim();
    return {
        ...(mention !== '' ? { content: mention } : {}),
        embeds: [embed],
        allowed_mentions: allowedMentionsFor(mention),
    };
}

export type FetchResponse = Readonly<{ status: number; text(): Promise<string> }>;

export type FetchLike = (
    url: string,
    init: Readonly<{ method: 'POST'; headers: Readonly<Record<string, string>>; body: string }>,
) => Promise<FetchResponse>;

export type PostOptions = Readonly<{
    fetchImpl?: FetchLike;
    sleepImpl?: (ms: number) => Promise<void>;
}>;

// fetch には既定のタイムアウトが無く、応答が無いと終了処理まで止まるので時間を区切る
const defaultFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

function retryAfterMs(text: string): number {
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && 'retry_after' in parsed && typeof parsed.retry_after === 'number') {
            return Math.ceil(parsed.retry_after * 1000);
        }
    } catch {
        // 本文が JSON でなければ既定の待ち時間にする
    }
    return DEFAULT_RETRY_AFTER_MS;
}

/** Webhook に POST する。接続失敗・429・5xx は再試行が残っているときだけ待って再試行し、それ以外の失敗は例外にする */
export async function postWebhook(url: string, payload: WebhookPayload, options: PostOptions = {}): Promise<void> {
    const fetchImpl = options.fetchImpl ?? defaultFetch;
    const sleepImpl = options.sleepImpl ?? ((ms: number) => sleep(ms));
    const body = JSON.stringify(payload);
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const hasRetryLeft = attempt < MAX_ATTEMPTS;
        let response: FetchResponse;
        try {
            response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        } catch (error) {
            lastError = new Error(`Discord に接続できませんでした: ${describeError(error)}`);
            if (hasRetryLeft) await sleepImpl(RETRY_BACKOFF_MS * attempt);
            continue;
        }
        if (response.status >= 200 && response.status < 300) return;

        const text = await response.text();
        if (response.status === 429) {
            lastError = new Error('Discord にレート制限されました (429)');
            if (hasRetryLeft) await sleepImpl(retryAfterMs(text));
            continue;
        }
        if (response.status >= 500) {
            lastError = new Error(`Discord が一時的なエラーを返しました (${response.status})`);
            if (hasRetryLeft) await sleepImpl(RETRY_BACKOFF_MS * attempt);
            continue;
        }
        throw new Error(`Discord Webhook への投稿が拒否されました (${response.status}): ${text.slice(0, 200)}`);
    }
    throw lastError ?? new Error('Discord Webhook への投稿に失敗しました');
}
