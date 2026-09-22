import type { FcmMessage } from './fcm/fcmListener.js';
import { describeError, type Logger } from './logger.js';
import { rememberPersistentId, type State } from './state.js';

export type MessagePumpDeps = Readonly<{
    initialState: State;
    relay: (appData: unknown, state: State) => Promise<State>;
    save: (state: State) => Promise<void>;
    log: Logger;
}>;

export type MessagePump = Readonly<{
    /** FCM から届いた通知を受け付ける。処理は順番に行われ、この呼び出し自体は待たない */
    onMessage: (message: FcmMessage) => void;
    /** 受け付け済みの通知の処理が全て終わるまで待つ */
    drain: () => Promise<void>;
    getState: () => State;
}>;

/** 受信した通知を届いた順に 1 件ずつ処理する。state の更新と保存が入れ違わないよう直列化し、1 件の失敗は次に影響させない */
export function createMessagePump(deps: MessagePumpDeps): MessagePump {
    let state = deps.initialState;
    let queue: Promise<void> = Promise.resolve();

    const handle = async (message: FcmMessage): Promise<void> => {
        if (message.persistentId !== undefined && state.persistentIds.includes(message.persistentId)) {
            deps.log.debug('受信済みの通知なので読み飛ばします');
            return;
        }
        state = await deps.relay(message.appData, state);
        // 転送を終えてから受信済みにする（転送前に落ちたら、再起動後に FCM の再送で拾い直せる）
        if (message.persistentId !== undefined) state = rememberPersistentId(state, message.persistentId);
        await deps.save(state);
    };

    return {
        onMessage(message) {
            queue = queue
                .then(() => handle(message))
                .catch((error: unknown) => deps.log.error(`通知の処理に失敗しました: ${describeError(error)}`));
        },
        drain: () => queue,
        getState: () => state,
    };
}
