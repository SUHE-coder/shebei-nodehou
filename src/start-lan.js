import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

function isPrivateIPv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

async function start() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT 必须是 1 到 65535 之间的整数，请检查 server/.env。');
    process.exitCode = 1;
    return;
  }

  const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']
    .filter((key) => !process.env[key]);
  if (missing.length) {
    console.error('缺少数据库配置，请先完成 server/.env 配置和 db:check。');
    process.exitCode = 1;
    return;
  }

  const addresses = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if ((entry.family === 'IPv4' || entry.family === 4)
        && !entry.internal && isPrivateIPv4(entry.address)) {
        addresses.push({ name, address: entry.address });
      }
    }
  }
  if (!addresses.length) {
    console.error('未找到局域网 IPv4 地址。请先连接 Wi-Fi 或有线局域网，然后重试。');
    console.error('如果使用特殊公司网络，请运行 ipconfig 并联系开发人员确认地址。');
    process.exitCode = 1;
    return;
  }

  const assetsDir = fileURLToPath(new URL('../dev-assets/', import.meta.url));
  await mkdir(assetsDir, { recursive: true });
  const pngPath = path.join(assetsDir, 'DEMO-001.png');
  const svgPath = path.join(assetsDir, 'DEMO-001.svg');
  const qrOptions = { errorCorrectionLevel: 'M', margin: 4, width: 400 };
  await QRCode.toFile(pngPath, 'DEMO-001', qrOptions);
  await QRCode.toFile(svgPath, 'DEMO-001', qrOptions);

  // 只在本次进程中启用局域网监听，不修改 .env 或小程序接口配置。
  process.env.HOST = '0.0.0.0';
  console.log('准备启动局域网调试服务。请将手机与电脑连接到同一个 Wi-Fi。');
  console.log('以下地址中，选择电脑 Wi-Fi 或有线网卡对应的地址：');
  for (const { name, address } of addresses) {
    console.log('网卡：' + name);
    console.log('手机健康检查：http://' + address + ':' + port + '/health');
    console.log('手机设备查询：http://' + address + ':' + port + '/api/devices/DEMO-001');
  }
  console.log('测试二维码已生成：' + pngPath);
  console.log('矢量二维码已生成：' + svgPath);
  console.log('二维码内容是设备编码 DEMO-001，供小程序内的扫码功能识别。');
  console.log('先在手机浏览器验证设备查询地址，成功后再配置真机小程序。');
  console.log('局域网调试结束后按 Ctrl+C 停止服务。');
  await import('./index.js');
}

start().catch((error) => {
  console.error('局域网调试启动失败：' + (error.code || 'UNKNOWN'));
  console.error('请确认依赖安装成功，且 server/dev-assets 可写。');
  process.exitCode = 1;
});
