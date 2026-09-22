/** 画面に出すログのレベル */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** FCM の接続状態 */
export type FcmStatus = 'connecting' | 'connected' | 'disconnected';

/** ログ 1 行 */
export type LogEvent = Readonly<{ type: 'log'; seq: number; time: string; level: LogLevel; message: string }>;

/** 通知 1 件をどう扱ったか */
export type NotificationOutcome = 'posted' | 'failed' | 'logged' | 'muted' | 'skipped' | 'ignored' | 'paired';

/** 通知履歴 1 件 */
export type NotificationEvent = Readonly<{
    type: 'notification';
    seq: number;
    time: string;
    kind: string;
    title: string;
    message: string;
    server?: string;
    outcome: NotificationOutcome;
    detail?: string;
}>;

/** 接続状態が変わったこと */
export type StatusEvent = Readonly<{ type: 'status'; seq: number; time: string; fcm: FcmStatus }>;

/** 画面に流す 1 件 */
export type HubEvent = LogEvent | NotificationEvent | StatusEvent;

// union を保ったまま seq と time だけ落とす（Omit をそのまま使うと共通の項目しか残らない）
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** publish に渡す形。seq と time は hub が付ける */
export type HubEventInput = DistributiveOmit<HubEvent, 'seq' | 'time'>;

/** 画面の上部に出す現在の状態 */
export type StatusSnapshot = Readonly<{ fcm: FcmStatus; lastNotificationAt: string | undefined; startedAt: string }>;

/** ログ・通知履歴・接続状態の置き場。画面へはここを通してだけ流す */
export type EventHub = Readonly<{
    /** seq と time を付けて保持・配信し、出来上がったイベントを返す */
    publish(event: HubEventInput): HubEvent;
    /** 保持している分を seq 順に返す */
    recent(): readonly HubEvent[];
    /** 購読する。戻り値を呼ぶと解除できる */
    subscribe(listener: (event: HubEvent) => void): () => void;
    /** 現在の状態 */
    status(): StatusSnapshot;
}>;

/** 保持件数と時刻の取り方。省略すると既定値を使う */
export type EventHubOptions = Readonly<{ maxLogs?: number; maxNotifications?: number; now?: () => Date }>;

const DEFAULT_MAX_LOGS = 500;
const DEFAULT_MAX_NOTIFICATIONS = 200;

/** ログ・通知履歴・接続状態を保持して購読者に配信する。ボット本体と Web 画面をつなぐ唯一の口 */
export function createEventHub(options: EventHubOptions = {}): EventHub {
    const maxLogs = options.maxLogs ?? DEFAULT_MAX_LOGS;
    const maxNotifications = options.maxNotifications ?? DEFAULT_MAX_NOTIFICATIONS;
    const now = options.now ?? ((): Date => new Date());
    const startedAt = now().toISOString();
    const logs: LogEvent[] = [];
    const notifications: NotificationEvent[] = [];
    const listeners = new Set<(event: HubEvent) => void>();
    let latestStatus: StatusEvent | undefined;
    let lastSeq = 0;

    return {
        publish(input) {
            lastSeq += 1;
            const event = { ...input, seq: lastSeq, time: now().toISOString() } as HubEvent;
            if (event.type === 'log') {
                logs.push(event);
                while (logs.length > maxLogs) logs.shift();
            } else if (event.type === 'notification') {
                notifications.push(event);
                while (notifications.length > maxNotifications) notifications.shift();
            } else {
                latestStatus = event;
            }
            for (const listener of listeners) {
                try {
                    listener(event);
                } catch {
                    // 購読者（SSE の 1 接続）の失敗で他の購読者や通知処理を巻き込まないため捨てる。
                    // ここで log を呼ぶと publish が再帰するのでログにも出せない
                }
            }
            return event;
        },
        recent() {
            const all: HubEvent[] = [...logs, ...notifications];
            if (latestStatus !== undefined) all.push(latestStatus);
            return all.sort((left, right) => left.seq - right.seq);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        status() {
            return {
                fcm: latestStatus?.fcm ?? 'connecting',
                lastNotificationAt: notifications.at(-1)?.time,
                startedAt,
            };
        },
    };
}
