import { consola } from 'consola';
import type { EventHub, LogLevel } from './web/eventHub.js';

/** アプリ内で使うログの口。テストでは差し替える */
export type Logger = Readonly<{
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}>;

/** stdout に出すロガーを作る。hub を渡すと Web 画面にも流す（絞り込みは画面側でするので debug も送る） */
export function createLogger(hub?: Pick<EventHub, 'publish'>): Logger {
    const base = consola.withTag('rust-bot');
    if (hub === undefined) return base;

    const relay =
        (level: LogLevel) =>
        (message: string): void => {
            base[level](message);
            hub.publish({ type: 'log', level, message });
        };
    return { debug: relay('debug'), info: relay('info'), warn: relay('warn'), error: relay('error') };
}

/** unknown で受けたエラーをログ用の 1 行にする */
export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
