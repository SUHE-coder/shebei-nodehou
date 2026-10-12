import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAuth } from '../src/auth.js';

const token = 'T'.repeat(43);
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(options = {}) {
  const user = { id: 7, name: '微信用户', role: 'viewer', status: 1, openid: 'verified_wechat_user', ...options.user };
  const calls = [];
  const sessions = new Map();
  let clock = 1000;
  let exchanges = 0;
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (options.dbError) throw Object.assign(new Error('private database detail'), { code: options.dbError });
      if (sql.startsWith('INSERT INTO users')) return [{ insertId: user.id }];
      if (sql.startsWith('SELECT id, name')) return [[{ ...user }]];
      if (sql.startsWith('INSERT INTO user_sessions')) {
        sessions.set(params[0], { userId: params[1], expiresAt: clock + 604800000 });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('SELECT u.id')) {
        const session = sessions.get(params[0]);
        return [[...(session && session.expiresAt > clock ? [{ ...user }] : [])]];
      }
      if (sql.startsWith('DELETE FROM user_sessions WHERE token_hash')) {
        sessions.delete(params[0]);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('DELETE FROM user_sessions WHERE expires_at')) return [{ affectedRows: 0 }];
      throw new Error('Unexpected SQL');
    }
  };
  const auth = createAuth({
    pool,
    appId: options.appId === undefined ? 'wx1234567890abcdef' : options.appId,
    appSecret: 'a'.repeat(32),
    issueToken: () => token,
    now: () => clock,
    exchangeCode: async () => {
      exchanges += 1;
      return options.wechatResult || { openid: 'verified_wechat_user', session_key: 'PRIVATE_WECHAT_KEY' };
    }
  });
  return { auth, calls, sessions, user, advance: milliseconds => { clock += milliseconds; }, get exchanges() { return exchanges; } };
}

function req(body = {}, bearer = '') {
  return { body, ip: '127.0.0.1', get: () => bearer };
}

async function invoke(handler, request) {
  const response = { statusCode: 200, body: null, headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let nextCalled = false;
  let forwarded;
  await handler(request, response, error => { nextCalled = true; forwarded = error; });
  if (forwarded) throw forwarded;
  return { ...response, nextCalled };
}

test('微信身份是唯一登录依据，客户端伪造角色和用户编号无效', async () => {
  const f = fixture();
  const response = await invoke(f.auth.login, req({ code: 'valid_code', role: 'admin', id: 1, openid: 'forged' }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.role, 'viewer');
  assert.equal(response.body.user.id, 7);
  assert.equal(response.body.token, token);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(f.calls[0].params[0], 'verified_wechat_user');
  assert.match(f.calls[0].sql, /'viewer', 1/);
  assert.equal(f.sessions.has(hash(token)), true);
  assert.equal(f.sessions.has(token), false);
  assert.equal(JSON.stringify(response.body).includes('PRIVATE_WECHAT_KEY'), false);
  assert.equal(Object.hasOwn(response.body.user, 'openid'), false);
});

test('原有管理员再次登录不降级', async () => {
  const f = fixture({ user: { role: 'admin' } });
  const response = await invoke(f.auth.login, req({ code: 'valid' }));
  assert.equal(response.body.user.role, 'admin');
  assert.match(f.calls[0].sql, /ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID\(id\)/);
});

test('停用账号无法签发登录令牌', async () => {
  const f = fixture({ user: { status: 0 } });
  const response = await invoke(f.auth.login, req({ code: 'valid' }));
  assert.equal(response.statusCode, 403);
  assert.equal(f.sessions.size, 0);
});

test('微信拒绝凭证时不注册用户', async () => {
  const f = fixture({ wechatResult: { errcode: 40029, errmsg: 'private detail' } });
  const response = await invoke(f.auth.login, req({ code: 'invalid' }));
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'WECHAT_40029');
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(response.body).includes('private detail'), false);
});

test('无效配置不调用微信服务', async () => {
  const f = fixture({ appId: 'your-app-id' });
  const response = await invoke(f.auth.login, req({ code: 'valid' }));
  assert.equal(response.body.code, 'WECHAT_NOT_CONFIGURED');
  assert.equal(f.exchanges, 0);
});

test('未携带令牌和伪造令牌不能通过认证', async () => {
  const f = fixture();
  assert.equal((await invoke(f.auth.requireUser, req())).statusCode, 401);
  assert.equal(f.calls.length, 0);
  assert.equal((await invoke(f.auth.requireUser, req({}, 'Bearer ' + 'X'.repeat(43)))).statusCode, 401);
});

test('登录到期拒绝继续访问', async () => {
  const f = fixture();
  await invoke(f.auth.login, req({ code: 'valid' }));
  f.advance(604800001);
  const response = await invoke(f.auth.requireUser, req({}, 'Bearer ' + token));
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'SESSION_EXPIRED');
  assert.match(f.calls.at(-1).sql, /s.expires_at > UTC_TIMESTAMP\(\)/);
});

test('角色被撤销后，同一登录令牌立即失去编辑权限', async () => {
  const f = fixture({ user: { role: 'editor' } });
  await invoke(f.auth.login, req({ code: 'valid' }));
  const request = req({}, 'Bearer ' + token);
  assert.equal((await invoke(f.auth.requireUser, request)).nextCalled, true);
  assert.equal((await invoke(f.auth.requireRole('admin', 'editor'), request)).nextCalled, true);
  f.user.role = 'viewer';
  await invoke(f.auth.requireUser, request);
  const response = await invoke(f.auth.requireRole('admin', 'editor'), request);
  assert.equal(response.statusCode, 403);
});

test('账号停用后，同一令牌不能继续访问', async () => {
  const f = fixture();
  await invoke(f.auth.login, req({ code: 'valid' }));
  f.user.status = 0;
  assert.equal((await invoke(f.auth.requireUser, req({}, 'Bearer ' + token))).statusCode, 403);
});

test('退出登录使原令牌失效', async () => {
  const f = fixture();
  await invoke(f.auth.login, req({ code: 'valid' }));
  const request = req({}, 'Bearer ' + token);
  await invoke(f.auth.requireUser, request);
  assert.equal((await invoke(f.auth.logout, request)).body.ok, true);
  assert.equal((await invoke(f.auth.requireUser, request)).statusCode, 401);
});

test('登录表未创建时返回可操作提示', async () => {
  const f = fixture({ dbError: 'ER_NO_SUCH_TABLE' });
  const response = await invoke(f.auth.login, req({ code: 'valid' }));
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'AUTH_SCHEMA_MISSING');
  assert.equal(JSON.stringify(response.body).includes('private database detail'), false);
});

test('登录频率受限并在一分钟后恢复', async () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) assert.equal((await invoke(f.auth.login, req())).statusCode, 400);
  assert.equal((await invoke(f.auth.login, req())).statusCode, 429);
  f.advance(60001);
  assert.equal((await invoke(f.auth.login, req())).statusCode, 400);
});
test('数据库大小写排序规则不能混淆两个微信身份', async () => {
  const f = fixture({ user: { openid: 'VERIFIED_WECHAT_USER', role: 'admin' } });
  const response = await invoke(f.auth.login, req({ code: 'valid' }));
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'ACCOUNT_IDENTITY_CONFLICT');
  assert.equal(f.sessions.size, 0);
});

