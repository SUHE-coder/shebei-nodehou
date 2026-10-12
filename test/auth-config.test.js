import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../src/auth.js';

const configuredId = 'wx1234567890abcdef';

function fixture(wechatResult) {
  let exchanges = 0;
  let queries = 0;
  const auth = createAuth({
    appId: configuredId,
    appSecret: 'a'.repeat(32),
    pool: { async query() { queries += 1; throw new Error('Login must not reach the database'); } },
    exchangeCode: async () => { exchanges += 1; return wechatResult; }
  });
  return { auth, get exchanges() { return exchanges; }, get queries() { return queries; } };
}

async function login(auth, appId) {
  const req = { ip: '127.0.0.1', body: { code: 'fake_private_code', appId } };
  const res = {
    statusCode: 200, body: null,
    set() { return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
  let forwarded;
  await auth.login(req, res, error => { forwarded = error; });
  if (forwarded) throw forwarded;
  return res;
}

test('项目 AppID 不一致时不消耗微信凭证，也不访问数据库', async () => {
  const f = fixture({});
  const result = await login(f.auth, 'wxabcdef1234567890');
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.code, 'APP_ID_MISMATCH');
  assert.equal(f.exchanges, 0);
  assert.equal(f.queries, 0);
});

test('无效客户端 AppID 被拒绝', async () => {
  const f = fixture({});
  const result = await login(f.auth, 'invalid AppID');
  assert.equal(result.body.code, 'INVALID_CLIENT_APP_ID');
  assert.equal(f.exchanges, 0);
});

test('40029 明确提示无效凭证并显示错误码', async () => {
  const f = fixture({ errcode: 40029, errmsg: 'private_wechat_response' });
  const result = await login(f.auth, configuredId);
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.code, 'WECHAT_40029');
  assert.match(result.body.message, /40029/);
  assert.equal(f.exchanges, 1);
  assert.equal(f.queries, 0);
  assert.equal(JSON.stringify(result.body).includes('private_wechat_response'), false);
  assert.equal(JSON.stringify(result.body).includes('fake_private_code'), false);
  assert.equal(JSON.stringify(result.body).includes('a'.repeat(32)), false);
});

test('40163 单独提示凭证已被使用', async () => {
  const f = fixture({ errcode: 40163 });
  const result = await login(f.auth, configuredId);
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.code, 'WECHAT_40163');
  assert.match(result.body.message, /已被使用/);
});
