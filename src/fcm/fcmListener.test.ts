import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger.js';
import type { FcmStatus } from '../web/eventHub.js';
import { startFcmListener } from './fcmListener.js';

const mocks = vi.hoisted(() => {
    class FakeClient {
        readonly handlers = new Map<string, Array<(data: unknown) => void>>();
        connect: () => Promise<void>;
        destroyed = false;

        constructor(
            readonly androidId: string,
            readonly securityToken: string,
            readonly persistentIds: string[],
        ) {
            this.connect = () => state.connect();
            instances.push(this);
        }

        on(event: string, handler: (data: unknown) => void): void {
            const list = this.handlers.get(event) ?? [];
            list.push(handler);
            this.handlers.set(event, list);
        }

        /** ライブラリ側からイベントが来たことにする */
        fire(event: string, data?: unknown): void {
            for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
        }

        destroy(): void {
            this.destroyed = true;
        }
    }
    const instances: FakeClient[] = [];
    const state = { connect: (): Promise<void> => Promise.resolve() };
    return { FakeClient, instances, state };
});

vi.mock('@liamcottle/push-receiver/src/client.js', () => ({ default: mocks.FakeClient }));

const logs: string[] = [];
const log: Logger = {
    debug: (message) => void logs.push(`debug ${message}`),
    info: (message) => void logs.push(`info ${message}`),
    warn: (message) => void logs.push(`warn ${message}`),
    error: (message) => void logs.push(`error ${message}`),
};

function start() {
    const statuses: FcmStatus[] = [];
    const listener = startFcmListener({
        androidId: '1',
        securityToken: '2',
        persistentIds: ['id-1'],
        log,
        onMessage: () => undefined,
        onStatus: (status) => void statuses.push(status),
    });
    const client = mocks.instances.at(-1);
    if (client === undefined) throw new Error('クライアントが作られていません');
    return { listener, client, statuses };
}

beforeEach(() => {
    vi.useFakeTimers();
    mocks.instances.length = 0;
    mocks.state.connect = (): Promise<void> => Promise.resolve();
    logs.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('startFcmListener の接続状態', () => {
    it('接続の開始で connecting、接続できたら connected を通知する', async () => {
        const { listener, client, statuses } = start();
        expect(statuses).toEqual(['connecting']);

        client.fire('connect');
        await vi.advanceTimersByTimeAsync(0);
        expect(statuses).toEqual(['connecting', 'connected']);
        expect(logs).toEqual(['info FCM に接続しました。通知を待っています']);
        listener.stop();
    });

    it('切断されたら disconnected を通知する', async () => {
        const { listener, client, statuses } = start();
        client.fire('disconnect');
        await vi.advanceTimersByTimeAsync(0);
        expect(statuses).toEqual(['connecting', 'disconnected']);
        listener.stop();
    });

    it('接続に失敗したら disconnected を通知し、再試行でまた connecting になる', async () => {
        mocks.state.connect = (): Promise<void> => Promise.reject(new Error('boom'));
        const { listener, statuses } = start();
        await vi.advanceTimersByTimeAsync(0);
        expect(statuses).toEqual(['connecting', 'disconnected']);

        await vi.advanceTimersByTimeAsync(15000);
        expect(statuses).toEqual(['connecting', 'disconnected', 'connecting', 'disconnected']);
        listener.stop();
    });

    it('stop した後は通知もログも出さない', async () => {
        const { listener, client, statuses } = start();
        listener.stop();
        logs.length = 0;
        statuses.length = 0;

        client.fire('disconnect');
        await vi.advanceTimersByTimeAsync(0);
        expect(statuses).toEqual([]);
        expect(logs).toEqual([]);
        expect(client.destroyed).toBe(true);
    });

    it('onStatus を渡さなくても動く', async () => {
        const listener = startFcmListener({
            androidId: '1',
            securityToken: '2',
            persistentIds: [],
            log,
            onMessage: () => undefined,
        });
        const client = mocks.instances.at(-1);
        expect(client).toBeDefined();
        client?.fire('connect');
        await vi.advanceTimersByTimeAsync(0);
        expect(logs).toEqual(['info FCM に接続しました。通知を待っています']);
        listener.stop();
    });
});
