declare module '@liamcottle/push-receiver/src/client.js' {
    import type { EventEmitter } from 'node:events';

    /**
     * MTalk（FCM）に接続して通知を受け取るクライアント。型定義が同梱されていないので、使う分だけここで宣言する。
     * 通知は 'ON_DATA_RECEIVED' で { persistentId, appData: [{ key, value }] } の形のまま届く
     */
    class PushReceiverClient extends EventEmitter {
        constructor(androidId: string, securityToken: string, persistentIds: string[]);
        /** 内部の再接続からも呼ばれる。失敗を拾うラッパに差し替えられるようプロパティとして宣言する */
        connect: () => Promise<void>;
        destroy(): void;
    }

    export = PushReceiverClient;
}
