import { describe, expect, it } from 'vitest';
import { createEventHub, type HubEvent } from './eventHub.js';

const at = (iso: string) => new Date(iso);

function fixedClock(times: readonly string[]) {
    let index = 0;
    return () => at(times[Math.min(index++, times.length - 1)] ?? '2026-09-22T00:00:00.000Z');
}

describe('createEventHub', () => {
    it('publish が seq と time を付けて返す', () => {
        const hub = createEventHub({ now: fixedClock(['2026-09-22T00:00:00.000Z', '2026-09-22T00:00:01.000Z']) });
        const event = hub.publish({ type: 'log', level: 'info', message: 'あ' });
        expect(event).toEqual({ type: 'log', seq: 1, time: '2026-09-22T00:00:01.000Z', level: 'info', message: 'あ' });
    });

    it('seq は種類をまたいで増える', () => {
        const hub = createEventHub();
        expect(hub.publish({ type: 'log', level: 'debug', message: 'a' }).seq).toBe(1);
        expect(hub.publish({ type: 'status', fcm: 'connected' }).seq).toBe(2);
        expect(
            hub.publish({ type: 'notification', kind: 'alarm', title: 't', message: 'm', outcome: 'posted' }).seq,
        ).toBe(3);
    });

    it('recent は保持分を seq 順に返す', () => {
        const hub = createEventHub();
        hub.publish({ type: 'log', level: 'info', message: 'a' });
        hub.publish({ type: 'notification', kind: 'alarm', title: 't', message: 'm', outcome: 'posted' });
        hub.publish({ type: 'status', fcm: 'connected' });
        hub.publish({ type: 'log', level: 'warn', message: 'b' });
        expect(hub.recent().map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    });

    it('ログと通知は上限を超えた分を古い順に捨てる（状態は最新だけ残る）', () => {
        const hub = createEventHub({ maxLogs: 2, maxNotifications: 1 });
        for (const message of ['a', 'b', 'c']) hub.publish({ type: 'log', level: 'info', message });
        for (const title of ['x', 'y']) {
            hub.publish({ type: 'notification', kind: 'alarm', title, message: 'm', outcome: 'posted' });
        }
        hub.publish({ type: 'status', fcm: 'connecting' });
        hub.publish({ type: 'status', fcm: 'connected' });

        const kept = hub.recent();
        expect(
            kept
                .filter((event): event is Extract<HubEvent, { type: 'log' }> => event.type === 'log')
                .map((event) => event.message),
        ).toEqual(['b', 'c']);
        expect(
            kept
                .filter((event): event is Extract<HubEvent, { type: 'notification' }> => event.type === 'notification')
                .map((event) => event.title),
        ).toEqual(['y']);
        expect(kept.filter((event) => event.type === 'status')).toHaveLength(1);
        expect(hub.status().fcm).toBe('connected');
    });

    it('購読は publish を受け取り、解除すると届かなくなる', () => {
        const hub = createEventHub();
        const received: HubEvent[] = [];
        const unsubscribe = hub.subscribe((event) => void received.push(event));
        hub.publish({ type: 'log', level: 'info', message: 'a' });
        unsubscribe();
        hub.publish({ type: 'log', level: 'info', message: 'b' });
        expect(received.map((event) => event.seq)).toEqual([1]);
    });

    it('購読者が例外を投げても他の購読者と保持は止まらない', () => {
        const hub = createEventHub();
        const received: HubEvent[] = [];
        hub.subscribe(() => {
            throw new Error('boom');
        });
        hub.subscribe((event) => void received.push(event));
        expect(() => hub.publish({ type: 'log', level: 'info', message: 'a' })).not.toThrow();
        expect(received).toHaveLength(1);
        expect(hub.recent()).toHaveLength(1);
    });

    it('status は起動時刻・最新の接続状態・最後の通知時刻を返す', () => {
        const hub = createEventHub({
            now: fixedClock([
                '2026-09-22T00:00:00.000Z',
                '2026-09-22T00:00:10.000Z',
                '2026-09-22T00:00:20.000Z',
                '2026-09-22T00:00:30.000Z',
            ]),
        });
        expect(hub.status()).toEqual({
            fcm: 'connecting',
            lastNotificationAt: undefined,
            startedAt: '2026-09-22T00:00:00.000Z',
        });

        hub.publish({ type: 'status', fcm: 'connected' });
        hub.publish({ type: 'notification', kind: 'alarm', title: 't', message: 'm', outcome: 'posted' });
        hub.publish({ type: 'log', level: 'info', message: 'a' });
        expect(hub.status()).toEqual({
            fcm: 'connected',
            lastNotificationAt: '2026-09-22T00:00:20.000Z',
            startedAt: '2026-09-22T00:00:00.000Z',
        });
    });
});
