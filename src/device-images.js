import { randomBytes } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream']);

function publicError(status, message, code) {
  return Object.assign(new Error(message), { status, publicMessage: message, code });
}

export function detectImage(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

function uploadError(error) {
  if (!error) return null;
  if (error.code === 'LIMIT_FILE_SIZE') return publicError(413, '图片不能超过 5 MB。', 'IMAGE_TOO_LARGE');
  if (error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT') {
    return publicError(400, '每次只能上传一张图片。', 'INVALID_IMAGE_FIELD');
  }
  if (error.publicMessage) return error;
  return publicError(400, '上传内容不正确，请重新选择图片。', 'INVALID_IMAGE');
}

export function createDeviceImages({
  pool, uploadRoot, files = { mkdir, open, unlink },
  makeFilename = extension => randomBytes(18).toString('hex') + '.' + extension
}) {
  const parseUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 2 },
    fileFilter(req, file, callback) {
      if (!supportedTypes.has(file.mimetype)) {
        callback(publicError(400, '图片格式不支持，请选择 JPG、PNG 或 WEBP。', 'INVALID_IMAGE_TYPE'));
        return;
      }
      callback(null, true);
    }
  }).single('image');

  function upload(req, res, next) {
    parseUpload(req, res, error => {
      const safeError = uploadError(error);
      if (safeError) {
        res.status(safeError.status).json({ message: safeError.publicMessage, code: safeError.code });
        return;
      }
      next();
    });
  }

  async function add(req, res, next) {
    let connection;
    let transactionOpen = false;
    let savedPath = '';
    let fileCreated = false;
    let committed = false;
    try {
      if (!req.user) throw publicError(401, '请先登录。', 'AUTH_REQUIRED');
      if (!['admin', 'editor'].includes(req.user.role)) {
        throw publicError(403, '当前账号没有设备维护权限，请联系管理员。', 'ROLE_FORBIDDEN');
      }
      res.set('Cache-Control', 'no-store');
      const code = typeof req.params.code === 'string' ? req.params.code.trim() : '';
      if (!code || code.length > 80 || /[\u0000-\u001f\u007f]/.test(code)) {
        throw publicError(400, '设备码不正确。', 'INVALID_DEVICE_CODE');
      }
      if (!req.file || !Buffer.isBuffer(req.file.buffer) || req.file.buffer.length < 1) {
        throw publicError(400, '请选择一张图片。', 'IMAGE_REQUIRED');
      }
      if (req.file.buffer.length > MAX_IMAGE_BYTES) {
        throw publicError(413, '图片不能超过 5 MB。', 'IMAGE_TOO_LARGE');
      }
      const extension = detectImage(req.file.buffer);
      const expectedType = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[extension];
      if (!extension || !supportedTypes.has(req.file.mimetype) ||
          req.file.mimetype !== 'application/octet-stream' && req.file.mimetype !== expectedType) {
        throw publicError(400, '图片内容或格式不支持，请选择 JPG、PNG 或 WEBP。', 'INVALID_IMAGE_CONTENT');
      }

      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionOpen = true;
      // 锁定设备行，让同一设备的图片排序和数量检查在并发上传时保持一致。
      const [deviceRows] = await connection.query(
        'SELECT id FROM devices WHERE device_code = ? AND archived_at IS NULL LIMIT 1 FOR UPDATE', [code]
      );
      const device = deviceRows[0];
      if (!device) throw publicError(404, '设备不存在，请先确认设备码。', 'DEVICE_NOT_FOUND');
      const deviceId = Number(device.id);
      if (!Number.isSafeInteger(deviceId) || deviceId < 1) throw new Error('INVALID_DEVICE_ID');
      const [orderRows] = await connection.query(
        'SELECT COUNT(*) AS imageCount, COALESCE(MAX(sort_order), -1) + 1 AS sortOrder FROM device_images WHERE device_id = ?',
        [deviceId]
      );
      if (Number(orderRows[0].imageCount) >= 10) {
        throw publicError(409, '每台设备最多保存 10 张图片。', 'DEVICE_IMAGE_LIMIT');
      }
      const sortOrder = Number(orderRows[0].sortOrder);
      const filename = makeFilename(extension);
      if (!/^[a-f0-9]{36}\.(jpg|png|webp)$/.test(filename)) throw new Error('INVALID_IMAGE_FILENAME');
      const relativeKey = '/media/device-images/' + deviceId + '/' + filename;
      savedPath = path.join(uploadRoot, String(deviceId), filename);
      await files.mkdir(path.dirname(savedPath), { recursive: true });
      const handle = await files.open(savedPath, 'wx');
      fileCreated = true;
      try { await handle.writeFile(req.file.buffer); }
      finally { await handle.close(); }

      const [imageResult] = await connection.query(
        'INSERT INTO device_images (device_id, object_key, sort_order) VALUES (?, ?, ?)',
        [deviceId, relativeKey, sortOrder]
      );
      await connection.query(
        "INSERT INTO device_logs (device_id, user_id, action, detail) VALUES (?, ?, 'update', ?)",
        [deviceId, req.user.id, JSON.stringify({ type: 'image_add', objectKey: relativeKey })]
      );
      await connection.commit();
      transactionOpen = false;
      committed = true;
      res.status(201).json({
        image: { id: imageResult.insertId, objectKey: relativeKey, url: relativeKey }
      });
    } catch (error) {
      if (connection && transactionOpen) {
        try { await connection.rollback(); }
        catch (rollbackError) { console.error('图片事务回滚失败：' + (rollbackError.code || 'UNKNOWN')); }
      }
      if (fileCreated && !committed) {
        try { await files.unlink(savedPath); }
        catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') console.error('图片清理失败：' + (unlinkError.code || 'UNKNOWN'));
        }
      }
      if (error.publicMessage) {
        res.status(error.status).json({ message: error.publicMessage, code: error.code });
      } else {
        next(error);
      }
    } finally {
      if (connection) connection.release();
    }
  }

  async function remove(req, res, next) {
    let connection;
    let transactionOpen = false;
    try {
      if (!req.user) throw publicError(401, '请先登录。', 'AUTH_REQUIRED');
      if (!['admin', 'editor'].includes(req.user.role)) {
        throw publicError(403, '当前账号没有设备维护权限，请联系管理员。', 'ROLE_FORBIDDEN');
      }
      res.set('Cache-Control', 'no-store');
      const code = typeof req.params.code === 'string' ? req.params.code.trim() : '';
      const imageId = Number(req.params.imageId);
      if (!code || code.length > 80 || /[\u0000-\u001f\u007f]/.test(code) ||
          !/^[1-9]\d*$/.test(req.params.imageId || '') || !Number.isSafeInteger(imageId)) {
        throw publicError(400, '设备码或照片编号不正确。', 'INVALID_IMAGE_ID');
      }
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionOpen = true;
      const [devices] = await connection.query(
        'SELECT id FROM devices WHERE device_code = ? AND archived_at IS NULL LIMIT 1 FOR UPDATE', [code]
      );
      if (!devices[0]) throw publicError(404, '设备不存在或已归档。', 'DEVICE_NOT_FOUND');
      const deviceId = Number(devices[0].id);
      const [images] = await connection.query(
        'SELECT object_key AS objectKey FROM device_images WHERE id = ? AND device_id = ? LIMIT 1', [imageId, deviceId]
      );
      if (!images[0]) {
        // 重试同一删除请求时返回成功，且不会删除其他设备的照片。
        await connection.commit();
        transactionOpen = false;
        return res.json({ ok: true, imageId });
      }
      const objectKey = images[0].objectKey;
      await connection.query('DELETE FROM device_images WHERE id = ? AND device_id = ?', [imageId, deviceId]);
      await connection.query(
        "INSERT INTO device_logs (device_id, user_id, action, detail) VALUES (?, ?, 'update', ?)",
        [deviceId, req.user.id, JSON.stringify({ type: 'image_remove', imageId, objectKey })]
      );
      await connection.commit();
      transactionOpen = false;
      // 提交成功后清理本地文件；路径只从数据库中的受控上传键生成。
      const match = typeof objectKey === 'string' && objectKey.match(
        new RegExp('^/media/device-images/' + deviceId + '/([a-f0-9]{36}\\.(?:jpg|png|webp))$')
      );
      if (match) {
        try { await files.unlink(path.join(uploadRoot, String(deviceId), match[1])); }
        catch (error) { if (error.code !== 'ENOENT') console.error('已删除照片文件清理失败：' + (error.code || 'UNKNOWN')); }
      }
      res.json({ ok: true, imageId });
    } catch (error) {
      if (connection && transactionOpen) {
        try { await connection.rollback(); }
        catch (rollbackError) { console.error('删除照片事务回滚失败：' + (rollbackError.code || 'UNKNOWN')); }
      }
      if (error.publicMessage) res.status(error.status).json({ message: error.publicMessage, code: error.code });
      else next(error);
    } finally { if (connection) connection.release(); }
  }
  return { upload, add, remove };
}
