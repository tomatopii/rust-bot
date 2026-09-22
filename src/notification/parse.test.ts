import { describe, expect, it } from 'vitest';
import { parseNotification } from './parse.js';

const appData = (fields: Record<string, string>) => Object.entries(fields).map(([key, value]) => ({ key, value }));

describe('parseNotification', () => {
    it('サーバーのペアリング通知を読む（数値は文字列にそろえ、playerToken は持ち出さない）', () => {
        const result = parseNotification(
            appData({
                title: 'My Server',
                message: 'Tap to pair with this server.',
                channelId: 'pairing',
                body: JSON.stringify({
                    type: 'server',
                    name: 'My Server',
                    ip: '1.2.3.4',
                    port: 28083,
                    playerId: '76561198000000000',
                    playerToken: -1234567,
                    desc: 'desc',
                    img: '',
                    logo: '',
                    url: '',
                }),
            }),
        );
        expect(result).toEqual({
            ok: true,
            notification: {
                kind: 'pairing-server',
                serverName: 'My Server',
                server: { ip: '1.2.3.4', port: '28083' },
                playerId: '76561198000000000',
            },
        });
    });

    it('スマートアラームのペアリング通知を読む', () => {
        const result = parseNotification(
            appData({
                title: 'My Server',
                message: 'Tap to pair with this device.',
                channelId: 'pairing',
                body: JSON.stringify({
                    type: 'entity',
                    name: 'My Server',
                    ip: '1.2.3.4',
                    port: '28083',
                    entityId: '123456',
                    entityName: 'Smart Alarm',
                    entityType: '2',
                }),
            }),
        );
        expect(result).toEqual({
            ok: true,
            notification: {
                kind: 'pairing-entity',
                serverName: 'My Server',
                server: { ip: '1.2.3.4', port: '28083' },
                entityId: '123456',
                entityName: 'Smart Alarm',
                entityType: '2',
            },
        });
    });

    it('ペアリング通知の必須項目が欠けていれば失敗する（欠けた値を "undefined" として通さない）', () => {
        const noPort = parseNotification(
            appData({ channelId: 'pairing', body: JSON.stringify({ type: 'server', ip: '1.2.3.4', playerId: '7' }) }),
        );
        expect(noPort.ok).toBe(false);
        if (!noPort.ok) expect(noPort.reason).toContain('port');

        const nullPort = parseNotification(
            appData({ channelId: 'pairing', body: JSON.stringify({ type: 'server', ip: '1.2.3.4', port: null, playerId: '7' }) }),
        );
        expect(nullPort.ok).toBe(false);

        const noEntityId = parseNotification(
            appData({ channelId: 'pairing', body: JSON.stringify({ type: 'entity', ip: '1.2.3.4', port: '1' }) }),
        );
        expect(noEntityId.ok).toBe(false);
        if (!noEntityId.ok) expect(noEntityId.reason).toContain('entityId');
    });

    it('スマートアラームの発報を読む', () => {
        const result = parseNotification(
            appData({
                title: 'Front door',
                message: 'Someone is at the door!',
                channelId: 'alarm',
                body: JSON.stringify({ type: 'alarm', ip: '1.2.3.4', port: '28083', entityId: '123456' }),
            }),
        );
        expect(result).toEqual({
            ok: true,
            notification: {
                kind: 'alarm',
                title: 'Front door',
                message: 'Someone is at the door!',
                server: { ip: '1.2.3.4', port: '28083' },
                entityId: '123456',
            },
        });
    });

    it('アラーム本文にサーバー名があれば持ち出す', () => {
        const result = parseNotification(
            appData({
                title: 'Front door',
                message: 'msg',
                channelId: 'alarm',
                body: JSON.stringify({ type: 'alarm', name: 'My Server', ip: '1.2.3.4', port: 28083 }),
            }),
        );
        expect(result).toEqual({
            ok: true,
            notification: {
                kind: 'alarm',
                title: 'Front door',
                message: 'msg',
                serverName: 'My Server',
                server: { ip: '1.2.3.4', port: '28083' },
            },
        });
    });

    it('アラームは付随情報が壊れていても発報として読む（落とさない）', () => {
        const result = parseNotification(
            appData({
                title: 'Front door',
                message: 'msg',
                channelId: 'alarm',
                body: JSON.stringify({ type: 'alarm', name: null, ip: '1.2.3.4', port: null, entityId: {} }),
            }),
        );
        expect(result).toEqual({ ok: true, notification: { kind: 'alarm', title: 'Front door', message: 'msg' } });
    });

    it('raid-alarm プラグインの通知（body.type なし）もアラームとして読む', () => {
        const result = parseNotification(
            appData({
                title: "You're getting raided!",
                message: 'Your base is under attack',
                channelId: 'alarm',
                body: JSON.stringify({ ip: '1.2.3.4', port: '28083', img: '' }),
            }),
        );
        expect(result).toEqual({
            ok: true,
            notification: {
                kind: 'alarm',
                title: "You're getting raided!",
                message: 'Your base is under attack',
                server: { ip: '1.2.3.4', port: '28083' },
            },
        });
    });

    it('body がないアラーム通知も読める', () => {
        const result = parseNotification(appData({ title: 'Alarm', message: 'msg', channelId: 'alarm' }));
        expect(result).toEqual({ ok: true, notification: { kind: 'alarm', title: 'Alarm', message: 'msg' } });
    });

    it('死亡とチームログインの通知を読む', () => {
        const death = parseNotification(
            appData({ title: 'You were killed', message: 'by X', channelId: 'player', body: JSON.stringify({ type: 'death' }) }),
        );
        expect(death).toEqual({ ok: true, notification: { kind: 'death', title: 'You were killed', message: 'by X' } });

        const login = parseNotification(
            appData({ title: 'Team', message: 'Y logged in', channelId: 'team', body: JSON.stringify({ type: 'login' }) }),
        );
        expect(login).toEqual({ ok: true, notification: { kind: 'team-login', title: 'Team', message: 'Y logged in' } });
    });

    it('知らない channelId や type は unknown として返す', () => {
        const result = parseNotification(
            appData({ title: 'News', message: 'Wipe today', channelId: 'news', body: JSON.stringify({ type: 'news' }) }),
        );
        expect(result).toEqual({
            ok: true,
            notification: { kind: 'unknown', channelId: 'news', bodyType: 'news', title: 'News', message: 'Wipe today' },
        });
    });

    it('形式が壊れていれば理由つきで失敗する', () => {
        expect(parseNotification('nope')).toEqual({ ok: false, reason: 'appData が key/value の配列ではない' });
        expect(parseNotification(appData({ title: 'x' }))).toEqual({ ok: false, reason: 'channelId がない' });
        expect(parseNotification(appData({ channelId: 'alarm', body: '{broken' }))).toEqual({
            ok: false,
            reason: 'body が JSON として読めない',
        });
        expect(parseNotification(appData({ channelId: 'alarm', body: '[1]' }))).toEqual({
            ok: false,
            reason: 'body が JSON オブジェクトではない',
        });
        const missingIp = parseNotification(
            appData({ channelId: 'pairing', body: JSON.stringify({ type: 'server', port: '1', playerId: '2' }) }),
        );
        expect(missingIp.ok).toBe(false);
    });
});
