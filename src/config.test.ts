import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const valid = {
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
    GCM_ANDROID_ID: '123456789',
    GCM_SECURITY_TOKEN: '987654321',
};

describe('loadConfig', () => {
    it('必須の 3 つがあれば既定値つきで読める', () => {
        const config = loadConfig(valid);
        expect(config.DISCORD_WEBHOOK_URL).toBe(valid.DISCORD_WEBHOOK_URL);
        expect(config.ALARM_MENTION).toBe('');
        expect(config.FORWARD_DEATH).toBe(false);
        expect(config.FORWARD_TEAM_LOGIN).toBe(false);
        expect(config.STATE_FILE).toBe('state.json');
        expect(config.SETTINGS_FILE).toBe('settings.json');
    });

    it('足りない項目を全て列挙して失敗する', () => {
        expect(() => loadConfig({})).toThrow(/DISCORD_WEBHOOK_URL[\s\S]*GCM_ANDROID_ID[\s\S]*GCM_SECURITY_TOKEN/);
    });

    it('Discord 以外の URL を拒否する', () => {
        expect(() => loadConfig({ ...valid, DISCORD_WEBHOOK_URL: 'https://example.com/hook' })).toThrow(/Webhook URL/);
    });

    it('android_id と security_token は数字だけを受け付ける', () => {
        expect(() => loadConfig({ ...valid, GCM_ANDROID_ID: 'abc' })).toThrow(/GCM_ANDROID_ID/);
        expect(loadConfig({ ...valid, GCM_SECURITY_TOKEN: ' 42 ' }).GCM_SECURITY_TOKEN).toBe('42');
    });

    it('STATE_FILE が空なら既定値にする', () => {
        expect(loadConfig({ ...valid, STATE_FILE: '' }).STATE_FILE).toBe('state.json');
        expect(loadConfig({ ...valid, STATE_FILE: '  ' }).STATE_FILE).toBe('state.json');
        expect(loadConfig({ ...valid, STATE_FILE: 'data/state.json' }).STATE_FILE).toBe('data/state.json');
    });

    it('SETTINGS_FILE が空なら既定値にする', () => {
        expect(loadConfig({ ...valid, SETTINGS_FILE: '' }).SETTINGS_FILE).toBe('settings.json');
        expect(loadConfig({ ...valid, SETTINGS_FILE: '  ' }).SETTINGS_FILE).toBe('settings.json');
        expect(loadConfig({ ...valid, SETTINGS_FILE: 'data/settings.json' }).SETTINGS_FILE).toBe('data/settings.json');
    });

    it('真偽値は true のときだけ真になる', () => {
        expect(loadConfig({ ...valid, FORWARD_DEATH: 'TRUE' }).FORWARD_DEATH).toBe(true);
        expect(loadConfig({ ...valid, FORWARD_DEATH: 'yes' }).FORWARD_DEATH).toBe(false);
        expect(loadConfig({ ...valid, FORWARD_TEAM_LOGIN: '' }).FORWARD_TEAM_LOGIN).toBe(false);
    });
});
