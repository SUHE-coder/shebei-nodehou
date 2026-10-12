# 本地连接已购买的 RDS

数据库实例、device_manager 数据库、device_api 账号、四张业务表和 DEMO-001 测试设备已经由用户在阿里云配置。

连接地址：rm-cn-ei54ztclf0001cto.rwlb.rds.aliyuncs.com，端口：3306。

## 1. 检查 Node.js

打开 PowerShell：

```powershell
Set-Location -LiteralPath 'D:\show\server'
node --version
npm.cmd --version
```

如果提示找不到命令，从 https://nodejs.org/en/download 安装 Windows LTS 版本，然后重新打开 PowerShell。

## 2. 准备本地配置

仅在 .env 不存在时从模板复制，避免覆盖已有密码：

```powershell
if (!(Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
notepad.exe .env
```

确认文件中的 DB_HOST、DB_PORT、DB_NAME 和 DB_USER 分别与上面的地址、3306、device_manager 和 device_api 一致。填写 DB_PASSWORD 时使用数据库账号密码，并用引号包裹以支持包含 # 的密码，例如 DB_PASSWORD="这里替换成实际密码"。

保存为 .env，不要另存为 .env.txt。密码只存本地，.gitignore 已排除 .env。数据库读取检查暂不需要填写 WECHAT_APP_ID 和 WECHAT_APP_SECRET。

## 3. 安装依赖并检查

```powershell
npm.cmd install
```

安装结束后执行：

```powershell
npm.cmd run db:check
```

脚本只读取数据，检查数据库、四张数据表和测试设备，不修改云数据库，也不输出密码；结束时关闭连接。

正常结果包含：

```text
数据库连接成功：device_manager
四张数据表检查通过。
测试设备查询成功：DEMO-001 / 一号楼环境监测仪 / 一号楼 / 2F / 设备间
数据库检查全部通过。
```

如超时，先在 PowerShell 执行：

```powershell
Test-NetConnection -ComputerName 'rm-cn-ei54ztclf0001cto.rwlb.rds.aliyuncs.com' -Port 3306
```

TcpTestSucceeded=True 仅表示端口可达；账号和表结构仍需通过 db:check 验证。电脑公网 IP 变化后需要更新 RDS 白名单。

## 4. 数据库检查通过后

在 PowerShell 中进入 D:\show\server 后执行：

```powershell
npm.cmd start
```

正常情况下会显示：

```text
设备 API 已启动：http://127.0.0.1:3000
健康检查：http://127.0.0.1:3000/health
测试设备：http://127.0.0.1:3000/api/devices/DEMO-001
```

保持这个窗口运行，在浏览器依次打开以上健康检查和测试设备地址。

- /health 应返回 {"ok":true}。
- /api/devices/DEMO-001 应返回 DEMO-001 的设备信息，包含 deviceCode、name、model、status、statusText、location、note、updatedAt 和 images。
- 测试设备未添加图片，images 为空数组属于正常情况。
- 查询不存在的设备返回 HTTP 404。

开发服务默认绑定 127.0.0.1，供本机浏览器和微信开发者工具调试。后面做手机真机调试时，再单独配置网络访问。当前 API 尚未完成微信登录和权限控制，下一阶段完成后再对外部署。

结束调试时在运行 API 的 PowerShell 窗口按 Ctrl+C，程序会停止服务并关闭数据库连接。

阿里云账号密码、数据库密码和小程序 AppSecret 均不需要通过聊天发送。
