import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../miniprogram/utils/auth.js', import.meta.url), 'utf8');

function fixture() {
  const storage = new Map();
  const calls = [];
  const pending = [];
  const app = { globalData: {} };
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wx1234567890abcdef' } }),
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    login: options => { calls.push(options); pending.push(options); }
  };
  const context = {
    module: { exports: {} }, wx, getApp: () => app,
    require: () => ({
      request: async (path, options) => {
        assert.equal(path, '/api/auth/login');
        assert.equal(options.data.appId, 'wx1234567890abcdef');
        assert.equal(options.skipAuth, true);
        return { token: 'T'.repeat(43), user: { id: 7, name: '微信用户', role: 'viewer' } };
      }
    })
  };
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/auth.js' });
  return { auth: context.module.exports, wx, calls, pending, storage };
}

test('并发点击登录只发起一次微信登录', async () => {
  const f = fixture();
  const first = f.auth.login();
  const second = f.auth.login();
  assert.equal(first, second);
  assert.equal(f.calls.length, 1);
  f.pending.shift().success({ code: 'first_code' });
  await Promise.all([first, second]);
  assert.equal(f.storage.get('token'), 'T'.repeat(43));
});

test('登录结束后再次登录会重新取得凭证', async () => {
  const f = fixture();
  const first = f.auth.login();
  f.pending.shift().success({ code: 'first_code' });
  await first;
  const second = f.auth.login();
  assert.equal(f.calls.length, 2);
  f.pending.shift().success({ code: 'second_code' });
  await second;
});

test('无法读取 AppID 时提示项目配置问题', async () => {
  const f = fixture();
  f.wx.getAccountInfoSync = () => { throw new Error('unavailable'); };
  await assert.rejects(f.auth.login(), /AppID/);
  assert.equal(f.calls.length, 0);
});

test('微信登录失败后允许重新获取凭证', async () => {
  const f = fixture();
  const first = f.auth.login();
  f.pending.shift().fail();
  await assert.rejects(first, /登录凭证/);
  const retry = f.auth.login();
  assert.equal(f.calls.length, 2);
  f.pending.shift().success({ code: 'retry_code' });
  await retry;
});
