import type { Config } from './config.js';
import { buildPayload, type PostableNotification, type WebhookPayload } from './discord/webhook.js';
import { describeError, type Logger } from './logger.js';
import { parseNotification } from './notification/parse.js';
import { rememberServer, serverKey, type State } from './state.js';

export type RelayDeps = Readonly<{
    config: Config;
    log: Logger;
    post: (payload: WebhookPayload) => Promise<void>;
    now: () => Date;
}>;

function assertUnreachable(value: never): never {
    throw new Error(`想定外の通知です: ${JSON.stringify(value)}`);
}

type AlarmNotification = Extract<PostableNotification, { kind: 'alarm' }>;

/** 通知本文のサーバー名 → ペアリング時に覚えた名前 → ip:port の順に使う。空白だけの名前は無い物として扱う */
function alarmServerLabel(notification: AlarmNotification, state: State): string | undefined {
    if (notification.serverName !== undefined && notification.serverName.trim() !== '') return notification.serverName;
    if (notification.server === undefined) return undefined;
    const key = serverKey(notification.server);
    return state.servers[key]?.name.trim() || key;
}

async function post(notification: PostableNotification, mention: string, state: State, deps: RelayDeps): Promise<void> {
    const serverLabel = notification.kind === 'alarm' ? alarmServerLabel(notification, state) : undefined;
    const payload = buildPayload(notification, { mention, serverLabel, now: deps.now() });
    try {
        await deps.post(payload);
        deps.log.info(`Discord に投稿しました: ${notification.title || notification.kind}`);
    } catch (error) {
        deps.log.error(`Discord への投稿に失敗しました: ${describeError(error)}`);
    }
}

/** 受信した 1 件の通知を処理し、更新後の state を返す。Discord への投稿失敗はログに残して呼び出し側には投げない */
export async function relayNotification(appData: unknown, state: State, deps: RelayDeps): Promise<State> {
    const parsed = parseNotification(appData);
    if (!parsed.ok) {
        deps.log.warn(`通知を読み飛ばしました: ${parsed.reason}`);
        return state;
    }

    const notification = parsed.notification;
    switch (notification.kind) {
        case 'pairing-server':
            deps.log.info(`サーバーとペアリングされました: ${notification.serverName} (${serverKey(notification.server)})`);
            return rememberServer(state, notification.server, notification.serverName);
        case 'pairing-entity':
            deps.log.info(
                `デバイスとペアリングされました: ${notification.entityName} (ID ${notification.entityId}) @ ${notification.serverName}`,
            );
            return state;
        case 'alarm':
            await post(notification, deps.config.ALARM_MENTION, state, deps);
            return state;
        case 'death':
            if (deps.config.FORWARD_DEATH) await post(notification, '', state, deps);
            else deps.log.debug(`死亡通知は転送しない設定です: ${notification.title}`);
            return state;
        case 'team-login':
            if (deps.config.FORWARD_TEAM_LOGIN) await post(notification, '', state, deps);
            else deps.log.debug(`ログイン通知は転送しない設定です: ${notification.title}`);
            return state;
        case 'unknown':
            // 実機の通知が想定外の形で届いたときに「届いていない」と区別できるよう、既定のログレベルで見えるようにする
            deps.log.info(
                `未対応の通知です: channelId=${notification.channelId} type=${notification.bodyType ?? '-'} title=${notification.title}`,
            );
            return state;
        default:
            return assertUnreachable(notification);
    }
}
