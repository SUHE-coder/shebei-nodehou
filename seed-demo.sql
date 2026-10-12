-- 开发测试数据：在 DMS 中选择 device_manager 后执行。
-- 占位用户为禁用的查看人员，不用于微信登录或授予管理权限。
-- 重复执行会跳过已存在的用户、设备和创建记录。
USE device_manager;

INSERT INTO users (openid, name, role, status)
SELECT seed.openid, '测试数据占位用户', 'viewer', 0
FROM (SELECT 'demo_seed_user' AS openid) AS seed
LEFT JOIN users AS existing_user ON existing_user.openid = seed.openid
WHERE existing_user.id IS NULL;

INSERT INTO devices (
  device_code, name, model, status, location, note,
  created_by, updated_by
)
SELECT
  'DEMO-001',
  '一号楼环境监测仪',
  'ENV-200',
  'active',
  '一号楼 / 2F / 设备间',
  '这是开发测试设备，用于验证扫码查询。',
  u.id,
  u.id
FROM users AS u
LEFT JOIN devices AS existing_device
  ON existing_device.device_code = 'DEMO-001'
WHERE u.openid = 'demo_seed_user'
  AND existing_device.id IS NULL;

INSERT INTO device_logs (device_id, user_id, action, detail)
SELECT
  d.id,
  u.id,
  'create',
  JSON_OBJECT('source', 'development_seed', 'note', '创建测试设备')
FROM devices AS d
JOIN users AS u ON u.id = d.created_by
LEFT JOIN device_logs AS existing_log
  ON existing_log.device_id = d.id AND existing_log.action = 'create'
WHERE d.device_code = 'DEMO-001'
  AND u.openid = 'demo_seed_user'
  AND existing_log.id IS NULL;

SELECT device_code, name, model, status, location, note
FROM devices
WHERE device_code = 'DEMO-001';
