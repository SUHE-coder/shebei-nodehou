-- 已有数据库升级：先确认 devices 中是否已有 latitude / longitude，再补充缺失列。
-- 新建数据库使用 schema.sql，无须执行本文件。
USE device_manager;
ALTER TABLE devices
  ADD COLUMN latitude DECIMAL(10, 7) NULL,
  ADD COLUMN longitude DECIMAL(10, 7) NULL;
