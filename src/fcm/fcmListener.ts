import PushReceiverClient from '@liamcottle/push-receiver/src/client.js';
import { describeError, type Logger } from '../logger.js';

const RECONNECT_DELAY_MS = 15000;

/** FCM から届いた 1 件。appData の中身は parseNotification で検証する */
export type FcmMessage = Readonly<{ persistentId: string | undefined; appData: unknown }>;

export type FcmListenerOptions = Readonly<{
    androidId: string;
    securityToken: string;
    /** 受信済みの通知 ID。ログイン時に送ると FCM が同じ通知を再送しなくなる */
    persistentIds: readonly string[];
    log: Logger;
    onMessage: (message: FcmMessage) => void;
}>;

export type FcmListener = Readonly<{ stop(): void }>;

function toMessage(data: unknown): FcmMessage {
    if (typeof data !== 'object' || data === null) return { persistentId: undefined, appData: undefined };
    const record = data as Readonly<Record<string, unknown>>;
    return {
        persistentId: typeof record['persistentId'] === 'string' ? record['persistentId'] : undefined,
        appData: record['appData'],
    };
}

/** FCM（Rust+ のプッシュ通知）の受信を始める。切断後の再接続はライブラリが行うが、接続そのものの失敗は拾わないのでここで再試行する */
export function startFcmListener(options: FcmListenerOptions): FcmListener {
    // ライブラリは渡した配列をそのまま書き換えるので、複製を渡して state 側の配列を守る
    const client = new PushReceiverClient(options.androidId, options.securityToken, [...options.persistentIds]);
    let stopped = false;
    let retryTimer: NodeJS.Timeout | undefined;

    client.on('connect', () => options.log.info('FCM に接続しました。通知を待っています'));
    client.on('disconnect', () => {
        if (!stopped) options.log.warn('FCM から切断されました。再接続します');
    });
    client.on('ON_DATA_RECEIVED', (data: unknown) => options.onMessage(toMessage(data)));

    const rawConnect = client.connect.bind(client);
    const connect = (): Promise<void> =>
        rawConnect().catch((error: unknown) => {
            if (stopped) return;
            options.log.error(
                `FCM への接続に失敗しました: ${describeError(error)}（${RECONNECT_DELAY_MS / 1000} 秒後に再試行します）`,
            );
            retryTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
        });
    // ライブラリ内部の再接続（切断後の _retry）は this.connect を呼び直すが、その失敗を誰も受け取らず
    // unhandledRejection でプロセスが落ちるので、失敗を拾うラッパに差し替えておく
    client.connect = connect;
    void connect();

    return {
        stop() {
            stopped = true;
            if (retryTimer !== undefined) clearTimeout(retryTimer);
            client.destroy();
        },
    };
}
