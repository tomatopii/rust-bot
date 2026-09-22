import { consola } from 'consola';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, describeError } from './logger.js';
import type { HubEvent, HubEventInput } from './web/eventHub.js';

const originalLevel = consola.level;

beforeAll(() => {
    // テスト中に consola の出力で結果が埋まらないようにする
    consola.level = -999;
});

afterAll(() => {
    consola.level = originalLevel;
});

function createHub() {
    const published: HubEventInput[] = [];
    const publish = (event: HubEventInput): HubEvent => {
        published.push(event);
        return { ...event, seq: published.length, time: '2026-09-22T00:00:00.000Z' } as HubEvent;
    };
    return { published, hub: { publish } };
}

describe('createLogger', () => {
    it('hub を渡すと全レベルをログイベントとして流す', () => {
        const { published, hub } = createHub();
        const log = createLogger(hub);
        log.debug('d');
        log.info('i');
        log.warn('w');
        log.error('e');
        expect(published).toEqual([
            { type: 'log', level: 'debug', message: 'd' },
            { type: 'log', level: 'info', message: 'i' },
            { type: 'log', level: 'warn', message: 'w' },
            { type: 'log', level: 'error', message: 'e' },
        ]);
    });

    it('hub が無くても使える', () => {
        const log = createLogger();
        expect(() => log.info('i')).not.toThrow();
    });
});

describe('describeError', () => {
    it('Error はメッセージ、それ以外は文字列にする', () => {
        expect(describeError(new Error('壊れました'))).toBe('壊れました');
        expect(describeError('素の文字列')).toBe('素の文字列');
    });
});
