# 微信登录与设备权限：分步设置

扫码查询已通过真机测试。当前阶段接入微信登录、查看用户编号、确认角色和退出登录；设备录入、图片上传及人员管理页面将在后续阶段接入。

## 第一步：创建登录会话表

在阿里云 DMS 中打开 `device_manager` 数据库的 SQL 窗口，复制并执行 [auth-schema.sql](auth-schema.sql) 的全部内容。

执行末尾的 `SHOW TABLES LIKE 'user_sessions';` 后，应查询到 `user_sessions`。

该 SQL 只增加登录会话表。会话保存在已有 RDS 中，这一步无需另购 Redis 或数据库服务。

## 第二步：配置小程序身份

需要使用具有 AppSecret 的小程序账号。登录微信公众平台的小程序后台，找到开发设置中的 AppID 和 AppSecret。微信后台菜单名称可能调整，以后台实际显示为准。

在电脑本地编辑 `D:\show\server\.env`，填写已有的两项：

```dotenv
WECHAT_APP_ID=你的小程序AppID
WECHAT_APP_SECRET=你的小程序AppSecret
```

保留数据库配置。AppSecret 只存放在后端本地配置，不写入小程序代码，也不发到聊天中。

微信开发者工具当前项目使用的 AppID 必须与后端一致。如果使用的是没有可用 AppSecret 的测试号或游客模式，先准备小程序账号及其 AppID、AppSecret，并在开发者工具中切换到该 AppID；用于真机调试的微信账号需要具备该小程序相应的开发者权限。

## 第三步：重启后端并登录

在后端 PowerShell 窗口按 Ctrl+C，进入 `D:\show\server` 后运行：

```powershell
npm.cmd run dev:lan
```

微信开发者工具重新编译并开启真机调试。手机进入首页的“设备信息管理”，点击“微信登录”。

成功后应显示：

- 用户编号：数据库分配的编号，请以实际显示为准。
- 身份：查看者。
- “刷新权限”和“退出登录”按钮。

不要把用户编号当成登录凭证。后端只信任微信验证结果和有效会话，不接受前端指定角色或用户编号登录。

电脑 IP 改变时，还需更新 `miniprogram/utils/api.js` 中的接口地址。

## 第四步：指定第一个管理员

先确认你自己的真机登录成功，记录页面显示的用户编号，再在 DMS 中按编号查询：

```sql
SELECT id, name, role, status FROM users WHERE id = 你的用户编号;
```

确认这是刚才登录生成的账号后，将 `你的用户编号` 替换为实际数字，单独执行：

```sql
UPDATE users
SET name = '设备管理员', role = 'admin'
WHERE id = 你的用户编号 AND status = 1 AND openid <> 'demo_seed_user';
```

手机点击“刷新权限”，应显示管理员。不要使用开发测试的 `demo_seed_user` 作为管理员，也不要根据猜测的编号授权。

之后指定编辑者也按对方登录后显示的编号操作，角色使用 `editor`。新账号自动成为查看者；权限不会自动授予第一个登录的人。

## 验证与接口

新增接口：

- `POST /api/auth/login`：提交 `wx.login` 返回的 `code`。
- `GET /api/auth/me`：查询当前账号及其最新角色。
- `POST /api/auth/logout`：撤销当前登录会话。

认证请求携带 `Authorization: Bearer <token>`。后端使用随机会话令牌，数据库仅保存令牌的 SHA-256 摘要；会话有效期为七天，过期后重新登录。每次认证都检查账号状态及当前角色。

业务逻辑已通过模拟微信服务、数据库和 Node 加密 API 的检查，包含伪造身份、停用账号、过期、退出、角色撤销及限流。当前工具环境无法启动本地 Node 进程，因此尚未执行真实 Node 测试或真实微信登录。

在电脑上可执行不访问真实 RDS 和微信的 Node 测试：

```powershell
npm.cmd run test:auth
```

真实微信登录以第三步手机中的结果为准。

## 常见提示

- “登录数据表尚未创建”：先执行 `auth-schema.sql`。
- “请先配置真实 AppID 和 AppSecret”：修改后端 `.env` 后重启后端。
- “微信登录配置不正确”：核对小程序 AppID 和对应的 AppSecret。
- “AppID 不一致”：统一微信公众平台、开发者工具项目和后端的 AppID，重启后端并重新编译。
- “微信拒绝登录凭证（40029）”：核对项目配置并重新进入真机调试；该错误不能单独证明凭证过期。
- “微信登录凭证已被使用（40163）”：重新取得凭证，检查是否有其他登录逻辑重复消费。

登录报错的逐步排查见 [微信登录凭证报错排查](WECHAT_LOGIN_TROUBLESHOOTING.md)。
- “无法连接微信登录服务”：检查电脑联网情况，查看后端窗口中的错误码。
- “该账号已停用”：管理员需在数据库检查该用户的 `status`。
- “登录已过期”：重新登录。

参考：[腾讯 CloudBase 对自建后端微信登录流程的说明](https://tcb.cloud.tencent.com/blog/2026/06/08/wechat-miniprogram-ai-skill)。

正式部署时再接入 HTTPS、设备维护接口和图片存储。
