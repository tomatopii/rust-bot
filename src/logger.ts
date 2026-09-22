import { consola } from 'consola';

/** アプリ内で使うログの口。テストでは差し替える */
export type Logger = Readonly<{
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}>;

/** stdout に出すロガーを作る */
export function createLogger(): Logger {
    return consola.withTag('rust-bot');
}

/** unknown で受けたエラーをログ用の 1 行にする */
export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
