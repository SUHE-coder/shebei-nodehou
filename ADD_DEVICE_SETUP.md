# 添加设备：本地验证

沿用已有 devices、device_logs 表，无须新建数据库表。手机定位需要补充 devices 的经纬度列，先运行 `npm.cmd run db:migrate:location`；该命令只添加缺失列，可重复执行。
管理员和编辑者可以添加设备；查看者只有查询权限。

## 1. 重启后端

在原后端 PowerShell 窗口按 Ctrl+C，然后执行：

```powershell
Set-Location D:\show\server
npm.cmd run dev:lan
```

继续沿用已经验证成功的 AppID、AppSecret 和局域网连接配置。

## 2. 重新编译小程序

微信开发者工具点击“编译”。真机请退出旧调试会话，重新开启真机调试。
进入“设备信息管理”，刷新权限，确认显示“管理员”，然后点击“添加设备”。

## 3. 保存第一台设备

建议测试资料：

- 设备码：DEMO-002
- 设备名称：二号测试设备
- 型号：TEST-002
- 位置：一号楼 / 3F / 设备间
- 状态：正常
- 备注：管理员新增设备测试

点击“保存设备”，应出现“设备保存成功”。不要使用已有的 DEMO-001。
设备码不能重复，包括已经归档但仍保留在数据库中的设备码。

## 4. 核对保存结果

在 DMS 执行：

```sql
USE device_manager;

SELECT id, device_code, name, model, status, location, note, created_by, updated_by
FROM devices
WHERE device_code = 'DEMO-002';

SELECT l.id, l.user_id, l.action, l.created_at
FROM device_logs l
JOIN devices d ON d.id = l.device_id
WHERE d.device_code = 'DEMO-002'
ORDER BY l.id DESC;
```

应有一条设备记录和一条 create 操作记录，首次添加的 created_by、updated_by 和日志 user_id 均为你的账号编号（当前管理员为 2）。

数据库和操作日志在同一个事务中写入，任何一项失败都会回滚。
重复设备码返回 409，客户端重复点击保存时只发送一次请求。
后端每次根据当前登录账号检查维护权限，不接受客户端传入的角色和操作人。

当前表单录入设备码、名称、型号、位置、状态、备注，并支持获取手机定位或地图选点；照片可以在同一页面预览并随设备一起上传。

如果已有数据库是在增加经纬度字段前创建的，请在 DMS 执行：

```sql
ALTER TABLE devices ADD COLUMN latitude DECIMAL(10, 7) NULL, ADD COLUMN longitude DECIMAL(10, 7) NULL;
```

## 自动检查

```powershell
Set-Location D:\show\server
npm.cmd run test:devices
```

测试覆盖权限、输入校验、参数化 SQL、重复码、日志失败回滚和数据库连接失败，使用模拟数据库。
Node 自动测试已运行通过；真实阿里云写入、手机定位和照片上传仍需按 [新版界面验证](../miniprogram/DEVICE_UI_SETUP.md) 中的流程在真机确认。
