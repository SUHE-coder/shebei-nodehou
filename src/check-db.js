import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

// 从 server/.env 加载配置；不输出密码，也不修改数据库。
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const hints = {
  CONFIG_MISSING: '请在 server/.env 中填写 DB_HOST、DB_NAME、DB_USER 和 DB_PASSWORD。',
  CONFIG_PORT: 'DB_PORT 必须是 1 到 65535 之间的整数。',
  ENOTFOUND: '无法解析连接地址。请检查 DB_HOST 是否与 RDS 外网连接地址一致。',
  EAI_AGAIN: '域名解析暂时失败，请检查网络后重试。',
  ETIMEDOUT: '连接超时。请检查外网地址、端口以及当前电脑的公网 IP 是否已加入白名单；实例如在唤醒中，可稍后重试。',
  ECONNREFUSED: '连接被拒绝。请检查外网连接是否已开通，以及端口是否正确。',
  ECONNRESET: '连接被中断，请检查网络和实例状态后重试。',
  PROTOCOL_CONNECTION_LOST: '数据库连接被关闭。若正在使用 FlClash/Clash/VPN，请先关闭 TUN 后重试；切换手机热点或 Wi-Fi 后，也要确认当前电脑的出口公网 IP 已加入 RDS 白名单。',
  ER_ACCESS_DENIED_ERROR: '账号或密码不正确，请检查 device_api 的密码。',
  ER_DBACCESS_DENIED_ERROR: '账号没有访问该数据库的权限，请在 RDS 中授权 device_manager。',
  ER_BAD_DB_ERROR: '数据库不存在，请确认 DB_NAME=device_manager。',
  TABLES_MISSING: '连接成功，但数据表不完整。请在 DMS 中完成四张表的创建。',
  TEST_DEVICE_MISSING: '连接成功，但未找到 DEMO-001。请在 DMS 中执行 server/seed-demo.sql。',
  ER_NO_SUCH_TABLE: '数据表不存在，请检查当前数据库及建表结果。'
};

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

let connection;

try {
  const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  if (required.some((key) => !process.env[key])) fail('CONFIG_MISSING');

  const port = Number(process.env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('CONFIG_PORT');

  console.log('正在连接数据库，请稍候…');
  connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    charset: 'utf8mb4',
    connectTimeout: 30000
  });

  const [databaseRows] = await connection.query({
    sql: 'SELECT DATABASE() AS current_database',
    timeout: 30000
  });
  console.log(`数据库连接成功：${databaseRows[0].current_database}`);

  const [tableRows] = await connection.query({ sql: 'SHOW TABLES', timeout: 30000 });
  const tableNames = new Set(tableRows.map((row) => Object.values(row)[0]));
  const requiredTables = ['users', 'devices', 'device_images', 'device_logs'];
  const missing = requiredTables.filter((table) => !tableNames.has(table));
  if (missing.length) {
    console.error(`缺少数据表：${missing.join(', ')}`);
    fail('TABLES_MISSING');
  }
  console.log('四张数据表检查通过。');

  const [devices] = await connection.query({
    sql: 'SELECT device_code, name, location FROM devices WHERE device_code = ? AND archived_at IS NULL LIMIT 1',
    values: ['DEMO-001'],
    timeout: 30000
  });
  if (!devices.length) fail('TEST_DEVICE_MISSING');

  console.log(`测试设备查询成功：${devices[0].device_code} / ${devices[0].name} / ${devices[0].location || '未填写位置'}`);
  console.log('数据库检查全部通过。');
} catch (error) {
  // 只显示错误代码和处理办法，避免输出包含配置或 SQL 的完整错误对象。
  const code = error.code || 'UNKNOWN';
  console.error(`检查未通过：${code}`);
  console.error(hints[code] || '请将这个错误代码发给开发人员排查，密码不用发送。');
  process.exitCode = 1;
} finally {
  if (connection) {
    try {
      await connection.end();
    } catch {
      console.error('连接关闭失败，请结束检查程序后重试。');
      process.exitCode = 1;
    }
  }
}
