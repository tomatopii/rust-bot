import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    alarmRouteFor,
    alarmTitleKey,
    createSettingsStore,
    DEFAULT_SETTINGS,
    loadSettings,
    parseSettings,
    rememberAlarmTitle,
    saveSettings,
    type Settings,
} from './settings.js';

let dir = '';
const warnings: string[] = [];
const errors: string[] = [];
const log = {
    warn: (message: string) => void warnings.push(message),
    error: (message: string) => void errors.push(message),
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rust-bot-'));
    warnings.length = 0;
    errors.length = 0;
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('alarmTitleKey', () => {
    it('前後の空白を除き、空の題名は固定の名前にする', () => {
        expect(alarmTitleKey('  Front door  ')).toBe('Front door');
        expect(alarmTitleKey('   ')).toBe('(無題)');
        expect(alarmTitleKey('')).toBe('(無題)');
    });

    it('長すぎる題名は設定ファイルに入る長さに切る', () => {
        expect(alarmTitleKey('a'.repeat(300))).toHaveLength(256);
    });
});

describe('alarmRouteFor', () => {
    const settings: Settings = {
        version: 1,
        unknownAlarmMode: 'log',
        alarms: { Front: { mode: 'mute' }, Back: { mode: 'discord', mention: '<@&1>' }, Side: { mode: 'discord', mention: '  ' } },
    };

    it('未設定の題名は unknownAlarmMode になり known=false', () => {
        expect(alarmRouteFor(settings, 'Unknown')).toEqual({ mode: 'log', mention: undefined, known: false });
    });

    it('設定済みの題名はその振り分けとメンションを使う', () => {
        expect(alarmRouteFor(settings, 'Front')).toEqual({ mode: 'mute', mention: undefined, known: true });
        expect(alarmRouteFor(settings, 'Back')).toEqual({ mode: 'discord', mention: '<@&1>', known: true });
    });

    it('空白だけのメンションは未設定として扱う', () => {
        expect(alarmRouteFor(settings, 'Side').mention).toBeUndefined();
    });
});

describe('rememberAlarmTitle', () => {
    it('未設定の題名を既定の振り分けで登録する', () => {
        const added = rememberAlarmTitle({ ...DEFAULT_SETTINGS, unknownAlarmMode: 'log' }, 'Front');
        expect(added.alarms['Front']).toEqual({ mode: 'log' });
        expect(DEFAULT_SETTINGS.alarms).toEqual({});
    });

    it('登録済みなら同じ参照を返す', () => {
        const once = rememberAlarmTitle(DEFAULT_SETTINGS, 'Front');
        expect(rememberAlarmTitle(once, 'Front')).toBe(once);
    });
});

describe('parseSettings', () => {
    it('省略された項目は既定値で埋める', () => {
        const parsed = parseSettings({ version: 1 });
        expect(parsed).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
    });

    it('題名ごとの設定を読み、メンションの空白を落とす', () => {
        const parsed = parseSettings({ version: 1, unknownAlarmMode: 'mute', alarms: { Front: { mode: 'log', mention: ' @here ' } } });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.settings.unknownAlarmMode).toBe('mute');
        expect(parsed.settings.alarms['Front']).toEqual({ mode: 'log', mention: '@here' });
    });

    it('知らない振り分け・空の題名・長すぎるメンションを理由つきで拒否する', () => {
        expect(parseSettings({ version: 1, alarms: { Front: { mode: 'sms' } } })).toMatchObject({ ok: false });
        expect(parseSettings({ version: 1, alarms: { '': { mode: 'log' } } })).toMatchObject({ ok: false });
        expect(parseSettings({ version: 1, alarms: { Front: { mode: 'log', mention: 'x'.repeat(201) } } })).toMatchObject({
            ok: false,
        });
        const wrongVersion = parseSettings({ version: 2 });
        expect(wrongVersion.ok).toBe(false);
        if (wrongVersion.ok) return;
        expect(wrongVersion.reason).toContain('version');
    });
});

describe('loadSettings / saveSettings', () => {
    it('ファイルが無ければ既定の設定', async () => {
        expect(await loadSettings(join(dir, 'settings.json'), log)).toEqual(DEFAULT_SETTINGS);
        expect(warnings).toEqual([]);
    });

    it('保存したものをそのまま読み戻せる（無いディレクトリも作る）', async () => {
        const path = join(dir, 'nested', 'settings.json');
        const settings = rememberAlarmTitle(DEFAULT_SETTINGS, 'Front door');
        await saveSettings(path, settings);
        expect(await loadSettings(path, log)).toEqual(settings);
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(settings);
    });

    it('壊れたファイルは警告して既定の設定にする', async () => {
        const path = join(dir, 'settings.json');
        await writeFile(path, '{broken', 'utf8');
        expect(await loadSettings(path, log)).toEqual(DEFAULT_SETTINGS);
        await writeFile(path, JSON.stringify({ version: 1, unknownAlarmMode: 'sms' }), 'utf8');
        expect(await loadSettings(path, log)).toEqual(DEFAULT_SETTINGS);
        expect(warnings).toHaveLength(2);
    });

    it('ファイルが無い以外の読み取り失敗は既定にせずそのまま投げる', async () => {
        // ディレクトリを readFile すると ENOENT ではないエラーになる（コードは OS で違うので内容は見ない）
        await expect(loadSettings(dir, log)).rejects.toThrow();
        expect(warnings).toEqual([]);
    });
});

describe('createSettingsStore', () => {
    it('更新はすぐ読めて、最後の値がファイルに残る', async () => {
        const path = join(dir, 'settings.json');
        const store = createSettingsStore(path, DEFAULT_SETTINGS, log);
        expect(store.get()).toBe(DEFAULT_SETTINGS);

        const first = rememberAlarmTitle(DEFAULT_SETTINGS, 'Front');
        const second = rememberAlarmTitle(first, 'Back');
        const saving = store.update(first);
        // 保存の完了を待たずに更新しても、メモリ上は新しい値になる
        expect(store.get()).toBe(first);
        await Promise.all([saving, store.update(second)]);

        expect(store.get()).toBe(second);
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(second);
    });

    it('保存に失敗しても例外にせずログに残す', async () => {
        const blocker = join(dir, 'blocker');
        await writeFile(blocker, 'not a directory', 'utf8');
        const store = createSettingsStore(join(blocker, 'settings.json'), DEFAULT_SETTINGS, log);
        const next = rememberAlarmTitle(DEFAULT_SETTINGS, 'Front');
        await expect(store.update(next)).resolves.toBeUndefined();
        expect(store.get()).toBe(next);
        expect(errors).toHaveLength(1);
    });
});
