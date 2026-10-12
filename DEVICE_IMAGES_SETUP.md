# 设备图片：开发阶段验证

当前照片保存在后端电脑的 server/uploads/device-images/<设备编号>/ 目录。
数据库 device_images 只记录图片相对地址及排序，device_logs 记录操作人。
沿用已经创建的两张表，无须增加数据库表。
后续上线可以把图片迁移到 OSS；本阶段不需要购买图片存储服务。
备份或迁移项目时，需要同时保留数据库记录和 uploads 目录。

## 第一步：安装依赖并重启

在正在运行后端的 PowerShell 窗口按 Ctrl+C，然后执行：

```powershell
Set-Location D:\show\server
npm.cmd install
npm.cmd run dev:lan
```

继续使用已经验证成功的正式小程序 AppID 和 AppSecret。
如果局域网 IP 改变，只需调整 miniprogram/utils/api.js 中的 API_BASE_URL，查询和图片上传共用这个地址。

## 第二步：重新编译并进入真机调试

开发者工具点击“编译”，退出旧的手机调试会话，重新扫码进入真机调试。
进入“设备信息管理”，点击“设备图片”。

## 第三步：给已保存设备补图片

1. 输入 DEMO-002，点击“查询 / 刷新图片”。
2. 确认显示之前保存的二号测试设备。
3. 点击“拍照 / 选择照片”，选择一张不超过 5 MB 的 JPG、PNG 或 WEBP。
4. 点击“上传照片”。
5. 应显示“图片上传成功”，图片列表应立即出现照片。
6. 点击“查询 / 刷新图片”，确认照片仍然显示，点击照片可放大预览。

新设备可以在“添加设备”页面直接选择并预览照片，点击“保存设备档案”后自动关联上传，无须先切换到相册。已保存设备可在“设备相册”中补充照片。
每台设备最多保存 10 张图片，管理员和编辑者可以上传；查看者可以查看。

如果上传提示超时或网络中断，先刷新列表确认是否已保存，再决定重试。
如果选择 iPhone 原始 HEIC 照片不受支持，请选择 JPG/PNG 照片或重新拍照。

## 第四步：确认原扫码查询

给 DEMO-001 上传测试照片，然后返回首页点击“查询测试设备”，确认原设备详情页也显示照片。
已有设备码标签的设备可直接扫码查询。DEMO-002 需要二维码内容为 DEMO-002 的标签才能通过扫描查到。

## 数据库核对（需要时）

```sql
USE device_manager;

SELECT d.device_code, i.id, i.object_key, i.sort_order
FROM device_images i
JOIN devices d ON d.id = i.device_id
WHERE d.device_code = 'DEMO-002'
ORDER BY i.sort_order, i.id;
```

返回地址类似 /media/device-images/设备编号/随机文件名.jpg。
图片二进制没有写入 RDS，小程序根据当前后端地址读取图片。
开发阶段照片需要后端保持运行，并让手机能访问电脑的局域网地址。

## 自动检查和范围

```powershell
Set-Location D:\show\server
npm.cmd run test:images
```

测试使用模拟数据库和文件存储，验证权限、文件签名、大小、设备不存在、数量限制、
日志失败和部分文件写入失败时的回滚清理、独占创建失败时不删除已有文件。
Node 自动测试已经运行通过；测试使用模拟数据库和文件存储。真机流程负责验证微信权限、相机选择、真实 multipart、数据库写入与网络图片展示。新版还补充了缩略图加载和本地路径回退验证，详见 [新版界面验证](../miniprogram/DEVICE_UI_SETUP.md)。

上传依赖使用 Multer 2.4.0 或更高的 2.x 版本。
版本依据：[Multer 官方补丁公告](https://github.com/expressjs/multer/security/advisories/GHSA-3pph-fpjx-jg34)。
微信图片接口参考：[微信官方 API 类型定义](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)。
