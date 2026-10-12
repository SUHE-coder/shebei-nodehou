import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import { createAuth } from './auth.js';
import { createDeviceAdmin } from './device-admin.js';
import { createDeviceImages } from './device-images.js';
import { createDeviceQuery } from './device-query.js';
import { createDeviceList } from './device-list.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 1,
  idleTimeout: 60000,
  connectTimeout: 30000,
  charset: 'utf8mb4'
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const auth = createAuth({ pool });
const deviceAdmin = createDeviceAdmin({ pool });
const imageUploadRoot = fileURLToPath(new URL('../uploads/device-images/', import.meta.url));
const deviceImages = createDeviceImages({ pool, uploadRoot: imageUploadRoot });
app.post('/api/auth/login', auth.login);
app.get('/api/auth/me', auth.requireUser, auth.me);
app.post('/api/auth/logout', auth.requireUser, auth.logout);
app.post('/api/devices', auth.requireUser, auth.requireRole('admin', 'editor'), deviceAdmin.create);
app.get('/api/devices', createDeviceList({ pool }));
app.put('/api/devices/:code', auth.requireUser, auth.requireRole('admin', 'editor'), deviceAdmin.update);
app.post('/api/devices/:code/images', auth.requireUser, auth.requireRole('admin', 'editor'), deviceImages.upload, deviceImages.add);
app.delete('/api/devices/:code/images/:imageId', auth.requireUser, auth.requireRole('admin', 'editor'), deviceImages.remove);
// 本地开发图片地址；与当前公开的设备查询接口保持一致。
app.use('/media/device-images', express.static(imageUploadRoot, {
  dotfiles: 'deny', index: false,
  setHeaders(res) { res.set('X-Content-Type-Options', 'nosniff'); }
}));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    console.error(`数据库健康检查失败：${error.code || 'UNKNOWN'}`);
    res.status(503).json({ ok: false });
  }
});

app.get('/api/devices/:code', createDeviceQuery({ pool }));

app.use((error, _req, res, _next) => {
  console.error(`API 请求失败：${error.code || 'UNKNOWN'}`);
  const status = error.type === 'entity.parse.failed' ? 400
    : error.type === 'entity.too.large' ? 413 : 500;
  res.status(status).json({
    message: status === 400 ? '请求内容不是有效的 JSON'
      : status === 413 ? '请求内容过大' : '服务暂时无法完成请求，请稍后重试'
  });
});

const server = app.listen(port, host, () => {
  console.log(`设备 API 已启动：http://${host}:${port}`);
  console.log(`健康检查：http://127.0.0.1:${port}/health`);
  console.log(`测试设备：http://127.0.0.1:${port}/api/devices/DEMO-001`);
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `端口 ${port} 已被占用，请先关闭已启动的 API 或修改 .env 的 PORT。`
    : `API 启动失败：${error.code || 'UNKNOWN'}`);
  process.exitCode = 1;
  pool.end().catch(() => {});
});

let stopping = false;
function stopServer() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    try {
      await pool.end();
      console.log('API 已停止，数据库连接已关闭。');
    } catch {
      console.error('数据库连接关闭失败。');
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', stopServer);
process.on('SIGTERM', stopServer);
