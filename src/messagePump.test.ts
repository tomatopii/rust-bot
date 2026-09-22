import { describe, expect, it } from 'vitest';
import type { FcmMessage } from './fcm/fcmListener.js';
import type { Logger } from './logger.js';
import { createMessagePump } from './messagePump.js';
import { EMPTY_STATE, rememberServer, type State } from './state.js';

type HarnessOptions = Readonly<{
    relay?: (appData: unknown, state: State) => Promise<State>;
    save?: (state: State) => Promise<void>;
}>;

function createHarness(options: HarnessOptions = {}) {
    const relayed: unknown[] = [];
    const saved: State[] = [];
    const logs: string[] = [];
    const log: Logger = {
        debug: (message) => void logs.push(`debug ${message}`),
        info: (message) => void logs.push(`info ${message}`),
        warn: (message) => void logs.push(`warn ${message}`),
        error: (message) => void logs.push(`error ${message}`),
    };
    const pump = createMessagePump({
        initialState: EMPTY_STATE,
        relay: async (appData, state) => {
            relayed.push(appData);
            return options.relay ? options.relay(appData, state) : state;
        },
        save: async (state) => {
            saved.push(state);
            await options.save?.(state);
        },
        log,
    });
    return { pump, relayed, saved, logs };
}

const message = (persistentId: string | undefined, appData: unknown = 'data'): FcmMessage => ({ persistentId, appData });

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createMessagePump', () => {
    it('同じ persistentId の 2 通目は転送せずに読み飛ばす', async () => {
        const { pump, relayed, saved, logs } = createHarness();
        pump.onMessage(message('a'));
        pump.onMessage(message('a'));
        await pump.drain();
        expect(relayed).toHaveLength(1);
        expect(saved).toHaveLength(1);
        expect(pump.getState().persistentIds).toEqual(['a']);
        expect(logs.some((line) => line.startsWith('debug'))).toBe(true);
    });

    it('同時に届いた通知も順番に処理し、state の更新が入れ違わない', async () => {
        const { pump, saved } = createHarness({
            relay: async (appData, state) => {
                await nextTick();
                return rememberServer(state, { ip: '1.2.3.4', port: String(appData) }, 'x');
            },
        });
        pump.onMessage(message('a', '1'));
        pump.onMessage(message('b', '2'));
        await pump.drain();
        expect(pump.getState().persistentIds).toEqual(['a', 'b']);
        expect(Object.keys(pump.getState().servers)).toEqual(['1.2.3.4:1', '1.2.3.4:2']);
        expect(saved.map((state) => state.persistentIds)).toEqual([['a'], ['a', 'b']]);
    });

    it('persistentId が無い通知は転送するが受信済みには記録しない', async () => {
        const { pump, relayed, saved } = createHarness();
        pump.onMessage(message(undefined));
        await pump.drain();
        expect(relayed).toHaveLength(1);
        expect(saved).toHaveLength(1);
        expect(pump.getState().persistentIds).toEqual([]);
    });

    it('保存に失敗してもログに残して次の通知を処理し続ける', async () => {
        let failures = 0;
        const { pump, relayed, logs } = createHarness({
            save: async () => {
                failures += 1;
                if (failures === 1) throw new Error('disk full');
            },
        });
        pump.onMessage(message('a'));
        pump.onMessage(message('b'));
        await pump.drain();
        expect(relayed).toHaveLength(2);
        expect(pump.getState().persistentIds).toEqual(['a', 'b']);
        expect(logs.some((line) => line.startsWith('error') && line.includes('disk full'))).toBe(true);
    });

    it('drain は処理中の通知が終わるまで待つ', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { pump, saved } = createHarness({
            relay: async (_appData, state) => {
                await gate;
                return state;
            },
        });
        pump.onMessage(message('a'));
        let drained = false;
        const draining = pump.drain().then(() => {
            drained = true;
        });
        await nextTick();
        expect(drained).toBe(false);
        expect(saved).toHaveLength(0);

        release();
        await draining;
        expect(drained).toBe(true);
        expect(saved).toHaveLength(1);
    });
});
