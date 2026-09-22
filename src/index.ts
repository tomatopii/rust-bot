import { loadConfig } from './config.js';
import { postWebhook } from './discord/webhook.js';
import { startFcmListener } from './fcm/fcmListener.js';
import { createLogger, describeError } from './logger.js';
import { createMessagePump } from './messagePump.js';
import { relayNotification } from './relay.js';
import { createSettingsStore, loadSettings } from './settings.js';
import { loadState, saveState } from './state.js';
import { createEventHub } from './web/eventHub.js';

// 終了時は処理中の通知を待ってから記録を保存するが、Discord が応答しない場合に備えて待ち時間を区切る。
// 投稿 1 件の最悪ケース（15 秒のタイムアウト × 3 回 + 待ち時間）より長くしておく
const EXIT_TIMEOUT_MS = 60000;

async function main(): Promise<void> {
    const hub = createEventHub();
    const log = createLogger(hub);
    const config = loadConfig();
    const initialState = await loadState(config.STATE_FILE, log);
    const settings = createSettingsStore(config.SETTINGS_FILE, await loadSettings(config.SETTINGS_FILE, log), log);
    const forwards = ['アラーム', ...(config.FORWARD_DEATH ? ['死亡'] : []), ...(config.FORWARD_TEAM_LOGIN ? ['ログイン'] : [])];
    log.info(`起動しました（転送: ${forwards.join('・')} / 記録: ${config.STATE_FILE}）`);

    const pump = createMessagePump({
        initialState,
        relay: (appData, state) =>
            relayNotification(appData, state, {
                config,
                log,
                post: (payload) => postWebhook(config.DISCORD_WEBHOOK_URL, payload),
                now: () => new Date(),
                settings,
                hub,
            }),
        save: (state) => saveState(config.STATE_FILE, state),
        log,
    });

    const listener = startFcmListener({
        androidId: config.GCM_ANDROID_ID,
        securityToken: config.GCM_SECURITY_TOKEN,
        persistentIds: initialState.persistentIds,
        log,
        onMessage: pump.onMessage,
        onStatus: (fcm) => void hub.publish({ type: 'status', fcm }),
    });

    let exiting = false;
    const exitAfterSaving = async (code: number): Promise<void> => {
        // 打ち切りでも要求された終了コードを使う（Ctrl+C の 0 を 1 に変えると start.bat が再起動してしまう）
        setTimeout(() => process.exit(code), EXIT_TIMEOUT_MS).unref();
        listener.stop();
        try {
            await pump.drain();
            await saveState(config.STATE_FILE, pump.getState());
        } catch (error) {
            log.error(`終了時の保存に失敗しました: ${describeError(error)}`);
            process.exit(1);
        }
        process.exit(code);
    };
    const shutdown = (signal: NodeJS.Signals): void => {
        if (exiting) return;
        exiting = true;
        log.info(`${signal} を受け取ったので終了します`);
        void exitAfterSaving(0);
    };
    // FCM ライブラリのソケット処理は例外を拾わずに投げてくることがある。受信を止めた後は何も届かないので、
    // 継続せずに記録を保存して終了し、start.bat の再起動に任せる
    const crash = (error: unknown): void => {
        if (exiting) return;
        exiting = true;
        log.error(`想定外のエラーで終了します: ${describeError(error)}`);
        void exitAfterSaving(1);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.on('uncaughtException', crash);
    process.on('unhandledRejection', crash);
}

main().catch((error: unknown) => {
    createLogger().error(describeError(error));
    process.exitCode = 1;
});
