# API 起步服务

这是小程序的最小读取接口，方便先把扫码查询链路跑通。

```powershell
cd server
Copy-Item .env.example .env
npm install
npm start
```

生产环境还需要接入微信 `code2Session` 登录、服务端 session、角色中间件和 OSS 临时上传凭证。新增/编辑接口必须从 session 中读取用户身份，再检查 `users.role`；不能信任小程序传来的角色字段。小程序中的 `utils/api.js` 将 `API_BASE_URL` 改成部署后的 HTTPS 域名即可。

读取接口：

```text
GET /api/devices/{device_code}
```

返回内容包含 `deviceCode`、`name`、`model`、`status`、`location`、`note`、`updatedAt` 和 `images`。设备不存在时返回 404。
"# shebei-nodehou" 
