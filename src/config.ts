import { z } from 'zod';
import { describeIssues } from './describeIssues.js';

const DISCORD_WEBHOOK_PREFIXES = [
    'https://discord.com/api/webhooks/',
    'https://discordapp.com/api/webhooks/',
] as const;

const STATE_FILE_DEFAULT = 'state.json';
const SETTINGS_FILE_DEFAULT = 'settings.json';

// .env の値は全て文字列なので、真偽値は 'true'（大文字小文字は問わない）だけを真にする
const envBoolean = z
    .string()
    .default('false')
    .transform((value) => value.trim().toLowerCase() === 'true');

const numericString = (label: string) =>
    z.string().trim().regex(/^\d+$/, `${label} は数字だけの文字列です（credentials ページの表示をそのまま貼ってください）`);

const configSchema = z.object({
    DISCORD_WEBHOOK_URL: z
        .string()
        .trim()
        .refine((url) => DISCORD_WEBHOOK_PREFIXES.some((prefix) => url.startsWith(prefix)), {
            message: 'Discord の Webhook URL（https://discord.com/api/webhooks/... ）を指定してください',
        }),
    GCM_ANDROID_ID: numericString('GCM_ANDROID_ID'),
    GCM_SECURITY_TOKEN: numericString('GCM_SECURITY_TOKEN'),
    ALARM_MENTION: z.string().trim().default(''),
    FORWARD_DEATH: envBoolean,
    FORWARD_TEAM_LOGIN: envBoolean,
    // .env に「STATE_FILE=」と空で書かれると undefined ではなく '' が来るので、空も既定値に倒す
    STATE_FILE: z
        .string()
        .trim()
        .default(STATE_FILE_DEFAULT)
        .transform((value) => (value === '' ? STATE_FILE_DEFAULT : value)),
    SETTINGS_FILE: z
        .string()
        .trim()
        .default(SETTINGS_FILE_DEFAULT)
        .transform((value) => (value === '' ? SETTINGS_FILE_DEFAULT : value)),
});

export type Config = Readonly<z.infer<typeof configSchema>>;

/** 環境変数（.env）を検証して設定を返す。不足や形式違いは全部まとめて 1 つの例外にする */
export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): Config {
    const result = configSchema.safeParse(env);
    if (!result.success) {
        const lines = describeIssues(result.error).map((line) => `  - ${line}`);
        throw new Error(`.env の設定に問題があります:\n${lines.join('\n')}`);
    }
    return result.data;
}
