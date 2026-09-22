import type { Config } from './config.js';
import { buildPayload, type PostableNotification, type WebhookPayload } from './discord/webhook.js';
import { describeError, type Logger } from './logger.js';
import { parseNotification } from './notification/parse.js';
import { alarmRouteFor, alarmTitleKey, rememberAlarmTitle, type SettingsStore } from './settings.js';
import { rememberAlarmFired, rememberEntity, rememberServer, serverKey, type State } from './state.js';
import type { EventHub, NotificationOutcome } from './web/eventHub.js';

/** 通知 1 件を処理するのに要るもの。テストではすべて差し替える */
export type RelayDeps = Readonly<{
    config: Config;
    log: Logger;
    post: (payload: WebhookPayload) => Promise<void>;
    now: () => Date;
    settings: SettingsStore;
    hub: Pick<EventHub, 'publish'>;
}>;

type HistoryEntry = Readonly<{
    kind: string;
    title: string;
    message: string;
    server?: string;
    outcome: NotificationOutcome;
    detail?: string;
}>;

type PostResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;

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

function publishHistory(deps: RelayDeps, entry: HistoryEntry): void {
    deps.hub.publish({ type: 'notification', ...entry });
}

async function post(notification: PostableNotification, mention: string, state: State, deps: RelayDeps): Promise<PostResult> {
    const serverLabel = notification.kind === 'alarm' ? alarmServerLabel(notification, state) : undefined;
    const payload = buildPayload(notification, { mention, serverLabel, now: deps.now() });
    try {
        await deps.post(payload);
        deps.log.info(`Discord に投稿しました: ${notification.title || notification.kind}`);
        return { ok: true };
    } catch (error) {
        const reason = describeError(error);
        deps.log.error(`Discord への投稿に失敗しました: ${reason}`);
        return { ok: false, reason };
    }
}

/** 転送する設定の通知を投稿し、結果を履歴に残す。履歴の題名は画面の振り分け一覧と突き合わせられるよう呼び出し側が決める */
async function forward(
    notification: PostableNotification,
    mention: string,
    historyTitle: string,
    state: State,
    deps: RelayDeps,
): Promise<void> {
    const server = notification.kind === 'alarm' ? alarmServerLabel(notification, state) : undefined;
    const result = await post(notification, mention, state, deps);
    publishHistory(deps, {
        kind: notification.kind,
        title: historyTitle,
        message: notification.message,
        server,
        outcome: result.ok ? 'posted' : 'failed',
        ...(result.ok ? {} : { detail: result.reason }),
    });
}

/** 題名ごとの設定に従ってアラームを振り分ける。未設定の題名は画面の一覧に出せるよう既定で登録する */
async function relayAlarm(notification: AlarmNotification, state: State, deps: RelayDeps): Promise<State> {
    const titleKey = alarmTitleKey(notification.title);
    const settings = deps.settings.get();
    const route = alarmRouteFor(settings, titleKey);
    if (!route.known) await deps.settings.update(rememberAlarmTitle(settings, titleKey));
    const next = rememberAlarmFired(state, titleKey, deps.now());

    switch (route.mode) {
        case 'discord':
            await forward(notification, route.mention ?? deps.config.ALARM_MENTION, titleKey, state, deps);
            return next;
        case 'log':
            deps.log.info(`アラーム（ログのみ）: ${titleKey}`);
            break;
        case 'mute':
            deps.log.debug(`アラーム（無視する設定）: ${titleKey}`);
            break;
        default:
            return assertUnreachable(route.mode);
    }
    publishHistory(deps, {
        kind: 'alarm',
        title: titleKey,
        message: notification.message,
        server: alarmServerLabel(notification, state),
        outcome: route.mode === 'log' ? 'logged' : 'muted',
    });
    return next;
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
            publishHistory(deps, {
                kind: notification.kind,
                title: notification.serverName,
                message: serverKey(notification.server),
                server: notification.serverName,
                outcome: 'paired',
            });
            return rememberServer(state, notification.server, notification.serverName);
        case 'pairing-entity':
            deps.log.info(
                `デバイスとペアリングされました: ${notification.entityName} (ID ${notification.entityId}) @ ${notification.serverName}`,
            );
            publishHistory(deps, {
                kind: notification.kind,
                title: notification.entityName,
                message: notification.serverName,
                server: notification.serverName,
                outcome: 'paired',
                detail: notification.entityId,
            });
            return rememberEntity(state, notification, deps.now());
        case 'alarm':
            return relayAlarm(notification, state, deps);
        case 'death':
        case 'team-login': {
            const forwarding = notification.kind === 'death' ? deps.config.FORWARD_DEATH : deps.config.FORWARD_TEAM_LOGIN;
            if (forwarding) {
                await forward(notification, '', notification.title, state, deps);
                return state;
            }
            const label = notification.kind === 'death' ? '死亡通知' : 'ログイン通知';
            deps.log.debug(`${label}は転送しない設定です: ${notification.title}`);
            publishHistory(deps, {
                kind: notification.kind,
                title: notification.title,
                message: notification.message,
                outcome: 'skipped',
            });
            return state;
        }
        case 'unknown':
            // 実機の通知が想定外の形で届いたときに「届いていない」と区別できるよう、既定のログレベルで見えるようにする
            deps.log.info(
                `未対応の通知です: channelId=${notification.channelId} type=${notification.bodyType ?? '-'} title=${notification.title}`,
            );
            publishHistory(deps, {
                kind: notification.kind,
                title: notification.title,
                message: notification.message,
                outcome: 'ignored',
                detail: `channelId=${notification.channelId}`,
            });
            return state;
        default:
            return assertUnreachable(notification);
    }
}
