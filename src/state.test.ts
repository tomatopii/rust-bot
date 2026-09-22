import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    EMPTY_STATE,
    entityKey,
    loadState,
    rememberAlarmFired,
    rememberEntity,
    rememberPersistentId,
    rememberServer,
    saveState,
    serverKey,
    type PairingEntityNotification,
} from './state.js';

let dir = '';
const warnings: string[] = [];
const log = { warn: (message: string) => void warnings.push(message) };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rust-bot-'));
    warnings.length = 0;
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('loadState / saveState', () => {
    it('ファイルが無ければ初期状態', async () => {
        expect(await loadState(join(dir, 'state.json'), log)).toEqual(EMPTY_STATE);
        expect(warnings).toEqual([]);
    });

    it('保存したものをそのまま読み戻せる（無いディレクトリも作る）', async () => {
        const path = join(dir, 'nested', 'state.json');
        const state = rememberServer(rememberPersistentId(EMPTY_STATE, 'id-1'), { ip: '1.2.3.4', port: '28083' }, 'My Server');
        await saveState(path, state);
        expect(await loadState(path, log)).toEqual(state);
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(state);
    });

    it('壊れたファイルは警告して初期状態にする', async () => {
        const path = join(dir, 'state.json');
        await writeFile(path, '{broken', 'utf8');
        expect(await loadState(path, log)).toEqual(EMPTY_STATE);
        await writeFile(path, JSON.stringify({ version: 2 }), 'utf8');
        expect(await loadState(path, log)).toEqual(EMPTY_STATE);
        expect(warnings).toHaveLength(2);
    });

    it('ファイルが無い以外の読み取り失敗は初期化せずそのまま投げる', async () => {
        // ディレクトリを readFile すると ENOENT ではないエラーになる（コードは OS で違うので内容は見ない）
        await expect(loadState(dir, log)).rejects.toThrow();
        expect(warnings).toEqual([]);
    });
});

describe('rememberPersistentId', () => {
    it('元の state を変えずに追加し、重複は増やさない', () => {
        const once = rememberPersistentId(EMPTY_STATE, 'a');
        const twice = rememberPersistentId(once, 'a');
        expect(EMPTY_STATE.persistentIds).toEqual([]);
        expect(once.persistentIds).toEqual(['a']);
        expect(twice).toBe(once);
    });

    it('上限を超えたら古いものから捨てる', () => {
        const filled = Array.from({ length: 501 }, (_, index) => `id-${index}`).reduce(rememberPersistentId, EMPTY_STATE);
        expect(filled.persistentIds).toHaveLength(500);
        expect(filled.persistentIds[0]).toBe('id-1');
        expect(filled.persistentIds.at(-1)).toBe('id-500');
    });
});

describe('rememberServer', () => {
    it('ip:port を添字にして名前を覚える', () => {
        const server = { ip: '1.2.3.4', port: '28083' };
        const state = rememberServer(EMPTY_STATE, server, 'My Server');
        expect(serverKey(server)).toBe('1.2.3.4:28083');
        expect(state.servers['1.2.3.4:28083']).toEqual({ name: 'My Server' });
        expect(EMPTY_STATE.servers).toEqual({});
    });
});

const pairing: PairingEntityNotification = {
    kind: 'pairing-entity',
    serverName: 'My Server',
    server: { ip: '1.2.3.4', port: '28083' },
    entityId: '9',
    entityName: 'Smart Alarm',
    entityType: '1',
};

describe('rememberEntity', () => {
    it('サーバーと ID の組を添字にしてデバイスを覚える', () => {
        const state = rememberEntity(EMPTY_STATE, pairing, new Date('2026-09-22T03:00:00Z'));
        expect(entityKey(pairing.server, '9')).toBe('1.2.3.4:28083/9');
        expect(state.entities['1.2.3.4:28083/9']).toEqual({
            server: '1.2.3.4:28083',
            entityId: '9',
            entityType: '1',
            entityName: 'Smart Alarm',
            pairedAt: '2026-09-22T03:00:00.000Z',
        });
        expect(EMPTY_STATE.entities).toEqual({});
    });

    it('同じデバイスの再ペアリングは上書きする', () => {
        const first = rememberEntity(EMPTY_STATE, pairing, new Date('2026-09-22T03:00:00Z'));
        const second = rememberEntity(first, { ...pairing, entityName: 'Renamed' }, new Date('2026-09-22T04:00:00Z'));
        expect(Object.keys(second.entities)).toHaveLength(1);
        expect(second.entities['1.2.3.4:28083/9']).toMatchObject({ entityName: 'Renamed', pairedAt: '2026-09-22T04:00:00.000Z' });
    });
});

describe('rememberAlarmFired', () => {
    it('題名ごとに回数を数え、最終発報時刻を更新する', () => {
        const once = rememberAlarmFired(EMPTY_STATE, 'Front door', new Date('2026-09-22T03:00:00Z'));
        const twice = rememberAlarmFired(once, 'Front door', new Date('2026-09-22T04:00:00Z'));
        expect(once.alarmTitles['Front door']).toEqual({ count: 1, lastFiredAt: '2026-09-22T03:00:00.000Z' });
        expect(twice.alarmTitles['Front door']).toEqual({ count: 2, lastFiredAt: '2026-09-22T04:00:00.000Z' });
        expect(EMPTY_STATE.alarmTitles).toEqual({});
    });
});

describe('古い state.json との互換', () => {
    it('entities と alarmTitles が無いファイルも読める', async () => {
        const path = join(dir, 'state.json');
        await writeFile(path, JSON.stringify({ version: 1, persistentIds: ['a'], servers: {} }), 'utf8');
        expect(await loadState(path, log)).toEqual({ ...EMPTY_STATE, persistentIds: ['a'] });
        expect(warnings).toEqual([]);
    });
});
