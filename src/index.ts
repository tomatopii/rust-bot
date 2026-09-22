import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { buildPayload, postWebhook } from './discord/webhook.js';
import { startFcmListener } from './fcm/fcmListener.js';
import { createLogger, describeError } from './logger.js';
import { createMessagePump } from './messagePump.js';
import { relayNotification } from './relay.js';
import { createSettingsStore, loadSettings } from './settings.js';
import { loadState, saveState } from './state.js';
import { createEventHub } from './web/eventHub.js';
import { readIndexPage, startWebServer, type WebServer } from './web/server.js';

// 終了時は処理中の通知を待ってから記録を保存するが、Discord が応答しない場合に備えて待ち時間を区切る。
// 投稿 1 件の最悪ケース（15 秒のタイムアウト × 3 回 + 待ち時間）より長くしておく
const EXIT_TIMEOUT_MS = 60000;
// Web サーバーの後始末に手間取っても、通知の記録の保存を待たせない
const WEB_CLOSE_TIMEOUT_MS = 5000;

/** 画面に出す版。読めなくても起動を止めないので 'dev' に倒す */
async function readVersion(): Promise<string> {
    try {
        const parsed: unknown = JSON.parse(await readFile(join(__dirname, '../package.json'), 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string') {
            return parsed.version;
        }
    } catch {
        // 版の表示は画面の飾りなので、読めなくても起動を続ける
    }
    return 'dev';
}

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

    let web: WebServer | undefined;
    if (config.WEB_PORT > 0) {
        try {
            web = await startWebServer(config.WEB_PORT, {
                hub,
                settings,
                getState: () => pump.getState(),
                testPost: () =>
                    postWebhook(
                        config.DISCORD_WEBHOOK_URL,
                        buildPayload(
                            { kind: 'alarm', title: 'テスト投稿', message: 'rust-bot の Web 画面からのテストです' },
                            { mention: '', serverLabel: undefined, now: new Date() },
                        ),
                    ),
                readPage: readIndexPage,
                log,
                forwards: { death: config.FORWARD_DEATH, teamLogin: config.FORWARD_TEAM_LOGIN },
                version: await readVersion(),
            });
            log.info(`Web 画面: http://127.0.0.1:${web.port}/`);
        } catch (error) {
            // 画面が開けなくても通知の転送は本業なので止めない
            log.error(`Web 画面を起動できませんでした（通知の転送は続けます）: ${describeError(error)}`);
        }
    }

    let exiting = false;
    const exitAfterSaving = async (code: number): Promise<void> => {
        // 打ち切りでも要求された終了コードを使う（Ctrl+C の 0 を 1 に変えると start.bat が再起動してしまう）
        setTimeout(() => process.exit(code), EXIT_TIMEOUT_MS).unref();
        if (web !== undefined) {
            const timeout = new Promise<void>((resolve) => void setTimeout(resolve, WEB_CLOSE_TIMEOUT_MS).unref());
            await Promise.race([web.close(), timeout]).catch((error: unknown) => {
                log.error(`Web 画面の終了に失敗しました: ${describeError(error)}`);
            });
        }
        listener.stop();
        try {
            await pump.drain();
            await settings.flush();
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
    // macOS / Linux で端末の窓を閉じたときも、記録を保存してから終える
    process.once('SIGHUP', shutdown);
    process.on('uncaughtException', crash);
    process.on('unhandledRejection', crash);
}

main().catch((error: unknown) => {
    createLogger().error(describeError(error));
    process.exitCode = 1;
});
