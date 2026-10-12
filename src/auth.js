import { createHash, randomBytes } from 'node:crypto';
import https from 'node:https';

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const roles = { admin: '管理员', editor: '编辑者', viewer: '查看者' };

function failure(status, message, code) {
  return Object.assign(new Error(message), { status, code, publicMessage: message });
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function exchangeWeChatCode({ appId, appSecret, code }) {
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search = new URLSearchParams({
    appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code'
  }).toString();
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const timer = setTimeout(() => {
      finish(failure(504, '微信登录验证超时，请重试。', 'WECHAT_TIMEOUT'));
      if (request) request.destroy();
    }, 10000);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    request = https.get(url, response => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 65536) {
          finish(failure(502, '微信登录服务返回异常，请稍后重试。', 'WECHAT_RESPONSE'));
          response.destroy();
          request.destroy();
        }
      });
      response.on('error', () => finish(failure(502, '无法连接微信登录服务，请稍后重试。', 'WECHAT_NETWORK')));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          finish(failure(502, '微信登录服务暂时不可用，请稍后重试。', 'WECHAT_HTTP'));
          return;
        }
        try {
          const result = JSON.parse(body);
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
          finish(null, result);
        } catch {
          finish(failure(502, '微信登录服务返回异常，请稍后重试。', 'WECHAT_RESPONSE'));
        }
      });
    });
    request.on('error', () => finish(failure(502, '无法连接微信登录服务，请检查电脑网络。', 'WECHAT_NETWORK')));
  });
}

export function createAuth({
  pool,
  appId = process.env.WECHAT_APP_ID,
  appSecret = process.env.WECHAT_APP_SECRET,
  exchangeCode = exchangeWeChatCode,
  issueToken = () => randomBytes(32).toString('base64url'),
  now = () => Date.now()
}) {
  const attempts = new Map();

  function userView(row) {
    return { id: row.id, name: row.name, role: row.role, roleText: roles[row.role] || '查看者' };
  }

  function handle(error, res, next) {
    if (error.publicMessage) {
      res.status(error.status).json({ message: error.publicMessage, code: error.code });
      return;
    }
    if (error.code === 'ER_NO_SUCH_TABLE') {
      res.status(503).json({ message: '登录数据表尚未创建，请先执行登录表 SQL。', code: 'AUTH_SCHEMA_MISSING' });
      return;
    }
    next(error);
  }

  function allowAttempt(ip) {
    const time = now();
    for (const [key, item] of attempts) {
      if (item.until <= time) attempts.delete(key);
    }
    const item = attempts.get(ip);
    if (item) {
      item.count += 1;
      return item.count <= 20;
    }
    if (attempts.size >= 1000) return false;
    attempts.set(ip, { count: 1, until: time + 60000 });
    return true;
  }

  function readToken(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.get('authorization') || '');
    if (!match) throw failure(401, '请先登录，或重新登录后再试。', 'AUTH_REQUIRED');
    return match[1];
  }

  async function login(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      if (!allowAttempt(req.ip || 'unknown')) {
        throw failure(429, '登录过于频繁，请一分钟后重试。', 'LOGIN_RATE_LIMIT');
      }
      const code = req.body && req.body.code;
      if (typeof code !== 'string' || !code.trim() || code.length > 256) {
        throw failure(400, '微信登录凭证无效，请重新点击登录。', 'INVALID_LOGIN_CODE');
      }
      if (!/^wx[A-Za-z0-9]{16}$/.test(appId || '') || !/^[a-fA-F0-9]{32}$/.test(appSecret || '')) {
        throw failure(503, '请先在后端 .env 中配置真实的微信 AppID 和 AppSecret。', 'WECHAT_NOT_CONFIGURED');
      }
      // 客户端 AppID 只用于检查项目配置，不作为用户身份或权限依据。
      const clientAppId = req.body.appId;
      if (clientAppId !== undefined) {
        if (typeof clientAppId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(clientAppId)) {
          throw failure(400, '无法识别当前小程序 AppID，请检查开发者工具项目配置。', 'INVALID_CLIENT_APP_ID');
        }
        if (clientAppId !== appId) {
          console.error('微信登录 AppID 不一致：小程序 ' + clientAppId + '，后端 ' + appId);
          throw failure(400,
            'AppID 不一致：小程序 ' + clientAppId + '，后端 ' + appId + '。请统一配置并重新编译。',
            'APP_ID_MISMATCH');
        }
      }
      // 身份只来自微信验证结果，不接受客户端提交的 openid、用户编号或角色。
      const result = await exchangeCode({ appId, appSecret, code: code.trim() });
      const wxCode = Number(result && result.errcode || 0);
      if (wxCode) {
        console.error('微信登录验证失败：错误码 ' + wxCode + '，后端 AppID ' + appId);
        const invalidCode = wxCode === 40029 || wxCode === 40163;
        const badConfig = wxCode === 40013 || wxCode === 40125 || wxCode === 40001;
        throw failure(
          invalidCode ? 401 : badConfig ? 503 : 502,
          wxCode === 40029 ? '微信拒绝登录凭证（40029）。请核对项目 AppID，重新进入真机调试后再登录。'
            : wxCode === 40163 ? '微信登录凭证已被使用（40163），请重新点击登录获取新凭证。'
            : badConfig ? '微信登录配置不正确，请检查后端 AppID 和 AppSecret。'
              : '微信登录服务暂时无法完成验证，请稍后重试。',
          'WECHAT_' + wxCode
        );
      }
      if (!result || typeof result.openid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(result.openid)) {
        throw failure(502, '微信登录服务未返回有效身份，请稍后重试。', 'WECHAT_INVALID_IDENTITY');
      }
      await pool.query(
        "INSERT INTO users (openid, name, role, status) VALUES (?, '微信用户', 'viewer', 1) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
        [result.openid]
      );
      const [rows] = await pool.query('SELECT id, name, role, status, openid FROM users WHERE openid = ? LIMIT 1', [result.openid]);
      const user = rows[0];
      // 避免用户表默认的不区分大小写排序规则把不同 OpenID 视为同一身份。
      if (!user || user.openid !== result.openid) {
        throw failure(409, '账号标识冲突，请联系管理员检查用户表。', 'ACCOUNT_IDENTITY_CONFLICT');
      }
      if (Number(user.status) !== 1) {
        throw failure(403, '该账号已停用，请联系管理员。', 'ACCOUNT_DISABLED');
      }
      await pool.query('DELETE FROM user_sessions WHERE expires_at <= UTC_TIMESTAMP() LIMIT 100');
      const token = issueToken();
      await pool.query(
        'INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))',
        [tokenHash(token), user.id]
      );
      res.json({ token, expiresIn: SESSION_SECONDS, user: userView(user) });
    } catch (error) {
      handle(error, res, next);
    }
  }

  async function requireUser(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      const hash = tokenHash(readToken(req));
      const [rows] = await pool.query(
        'SELECT u.id, u.name, u.role, u.status FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() LIMIT 1',
        [hash]
      );
      const user = rows[0];
      if (!user) throw failure(401, '登录已过期，请重新登录。', 'SESSION_EXPIRED');
      if (Number(user.status) !== 1) throw failure(403, '该账号已停用，请联系管理员。', 'ACCOUNT_DISABLED');
      // 每次请求读取当前角色，数据库撤销权限后立即生效。
      req.user = userView(user);
      req.authTokenHash = hash;
      next();
    } catch (error) {
      handle(error, res, next);
    }
  }

  function requireRole(...allowed) {
    return function checkRole(req, res, next) {
      if (!req.user) {
        res.status(401).json({ message: '请先登录。', code: 'AUTH_REQUIRED' });
        return;
      }
      if (!allowed.includes(req.user.role)) {
        res.status(403).json({ message: '当前账号没有设备维护权限，请联系管理员。', code: 'ROLE_FORBIDDEN' });
        return;
      }
      next();
    };
  }

  function me(req, res) {
    res.json({ user: req.user });
  }

  async function logout(req, res, next) {
    try {
      await pool.query('DELETE FROM user_sessions WHERE token_hash = ?', [req.authTokenHash]);
      res.json({ ok: true });
    } catch (error) {
      handle(error, res, next);
    }
  }

  return { login, requireUser, requireRole, me, logout };
}
