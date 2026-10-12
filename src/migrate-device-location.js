import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
let connection;
try {
  if (['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].some(key => !process.env[key])) {
    throw Object.assign(new Error('数据库配置缺失'), { code: 'CONFIG_MISSING' });
  }
  connection = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    connectTimeout: 15000, charset: 'utf8mb4'
  });
  const [columns] = await connection.query({ sql: 'SHOW COLUMNS FROM devices', timeout: 15000 });
  const existing = new Set(columns.map(column => column.Field));
  const missing = ['latitude', 'longitude'].filter(column => !existing.has(column));
  if (missing.length) {
    const additions = missing.map(column => 'ADD COLUMN ' + column + ' DECIMAL(10, 7) NULL').join(', ');
    await connection.query({ sql: 'ALTER TABLE devices ' + additions, timeout: 15000 });
    console.log('已新增设备定位字段：' + missing.join(', ') + '。已有设备资料保持不变。');
  } else {
    console.log('设备定位字段已存在，无须升级。');
  }
} catch (error) {
  console.error('设备定位字段升级失败：' + (error.code || 'UNKNOWN'));
  console.error('可在 DMS 执行 server/device-location-schema.sql，仅补充缺失的字段，然后重启后端。');
  process.exitCode = 1;
} finally {
  if (connection) await connection.end();
}
