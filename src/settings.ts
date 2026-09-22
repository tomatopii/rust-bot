import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { describeIssues } from './describeIssues.js';
import { describeError, type Logger } from './logger.js';
import { ownValue } from './record.js';

/** アラームの題名ごとの扱い。discord=投稿する / log=ログだけ / mute=無視する */
export const ALARM_MODES = ['discord', 'log', 'mute'] as const;

export type AlarmMode = (typeof ALARM_MODES)[number];

/** 題名 1 件の設定。mention を入れると ALARM_MENTION を上書きする */
export type AlarmSetting = Readonly<{ mode: AlarmMode; mention?: string }>;

/** settings.json の中身。秘密の値は入れない */
export type Settings = Readonly<{
    version: 1;
    unknownAlarmMode: AlarmMode;
    alarms: Readonly<Record<string, AlarmSetting>>;
}>;

/** 題名が無いアラームの表示名。空の添字は画面で扱えないので固定の名前にする */
const UNTITLED_KEY = '(無題)';

const MAX_TITLE_LENGTH = 256;
const MAX_MENTION_LENGTH = 200;

const alarmSettingSchema = z.object({
    mode: z.enum(ALARM_MODES),
    mention: z.string().trim().max(MAX_MENTION_LENGTH).optional(),
});

const settingsSchema = z.object({
    version: z.literal(1),
    unknownAlarmMode: z.enum(ALARM_MODES).default('discord'),
    alarms: z.record(z.string().min(1).max(MAX_TITLE_LENGTH), alarmSettingSchema).default({}),
});

export const DEFAULT_SETTINGS: Settings = { version: 1, unknownAlarmMode: 'discord', alarms: {} };

/** 題名を振り分けの添字にする。前後の空白を除き、空なら固定の名前にする */
export function alarmTitleKey(title: string): string {
    const trimmed = title.trim();
    return trimmed === '' ? UNTITLED_KEY : trimmed.slice(0, MAX_TITLE_LENGTH);
}

export type AlarmRoute = Readonly<{ mode: AlarmMode; mention: string | undefined; known: boolean }>;

/** 題名に対する振り分けを返す。未設定なら unknownAlarmMode で known=false */
export function alarmRouteFor(settings: Settings, titleKey: string): AlarmRoute {
    const setting = ownValue(settings.alarms, titleKey);
    if (setting === undefined) return { mode: settings.unknownAlarmMode, mention: undefined, known: false };
    // 画面から空欄で送られた mention は「上書きしない」を意味するので未設定に倒す
    const mention = setting.mention?.trim();
    return { mode: setting.mode, mention: mention === '' ? undefined : mention, known: true };
}

/** 未設定の題名を unknownAlarmMode で登録した settings を返す。登録済みなら同じ参照を返す */
export function rememberAlarmTitle(settings: Settings, titleKey: string): Settings {
    if (ownValue(settings.alarms, titleKey) !== undefined) return settings;
    return { ...settings, alarms: { ...settings.alarms, [titleKey]: { mode: settings.unknownAlarmMode } } };
}

export type ParseSettingsResult = Readonly<{ ok: true; settings: Settings }> | Readonly<{ ok: false; reason: string }>;

/** 画面から届いた JSON を検証する。失敗理由は人が読める 1 行にする */
export function parseSettings(input: unknown): ParseSettingsResult {
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: describeIssues(parsed.error).join(', ') };
    return { ok: true, settings: parsed.data };
}

function isNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** 設定ファイルを読む。無ければ既定、壊れていれば警告して既定にする */
export async function loadSettings(path: string, log: Pick<Logger, 'warn'>): Promise<Settings> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if (isNotFound(error)) return DEFAULT_SETTINGS;
        throw error;
    }

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        log.warn(`${path} が JSON として読めないので既定の設定にします`);
        return DEFAULT_SETTINGS;
    }
    const parsed = parseSettings(json);
    if (!parsed.ok) {
        log.warn(`${path} の形式が想定と違うので既定の設定にします: ${parsed.reason}`);
        return DEFAULT_SETTINGS;
    }
    return parsed.settings;
}

/** 設定ファイルを書く。書き込み途中で落ちても壊れたファイルが残らないよう、一時ファイルを書いてから置き換える */
export async function saveSettings(path: string, settings: Settings): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf8');
    await rename(tmpPath, path);
}

export type SettingsStore = Readonly<{
    /** 現在の設定 */
    get(): Settings;
    /** 設定を差し替えて保存する。保存に失敗してもメモリ上の値は新しいまま */
    update(next: Settings): Promise<void>;
}>;

/** メモリ上の現在値を正とする設定の置き場。保存は直列化し、通知処理と画面からの更新が入れ違っても最後の値が残る */
export function createSettingsStore(path: string, initial: Settings, log: Pick<Logger, 'error'>): SettingsStore {
    let current = initial;
    let queue: Promise<void> = Promise.resolve();

    return {
        get: () => current,
        update(next) {
            current = next;
            queue = queue
                .then(() => saveSettings(path, next))
                // 保存に失敗しても通知の転送は続けたいので、例外にせずログに残す（次の update でまた保存される）
                .catch((error: unknown) => log.error(`${path} の保存に失敗しました: ${describeError(error)}`));
            return queue;
        },
    };
}
