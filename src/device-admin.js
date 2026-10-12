function publicError(status, message, code) {
  return Object.assign(new Error(message), { status, publicMessage: message, code });
}

const statusLabels = { active: '正常', maintenance: '维修中', retired: '已停用' };

function textField(body, key, label, maxLength, required = false) {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) throw publicError(400, '请填写' + label + '。', 'INVALID_DEVICE');
    return null;
  }
  if (typeof value !== 'string') {
    throw publicError(400, label + '必须是文字。', 'INVALID_DEVICE');
  }
  const text = value.trim();
  if (required && !text) throw publicError(400, '请填写' + label + '。', 'INVALID_DEVICE');
  if (text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw publicError(400, label + '过长或含有不支持的字符。', 'INVALID_DEVICE');
  }
  if (key !== 'note' && /[\r\n\t]/.test(text)) {
    throw publicError(400, label + '不能包含换行或制表符。', 'INVALID_DEVICE');
  }
  return text || null;
}

function coordinatesField(body) {
  const coordinates = body.coordinates;
  if (coordinates === undefined || coordinates === null) return null;
  if (!coordinates || typeof coordinates !== 'object' || Array.isArray(coordinates)) {
    throw publicError(400, '设备位置坐标不正确。', 'INVALID_DEVICE_LOCATION');
  }
  const { latitude, longitude } = coordinates;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw publicError(400, '设备位置坐标不正确。', 'INVALID_DEVICE_LOCATION');
  }
  return { latitude, longitude };
}

export function createDeviceAdmin({ pool }) {
  async function create(req, res, next) {
    let connection;
    let transactionOpen = false;
    try {
      // req.user 由登录中间件从数据库读取；不使用客户端提交的角色或用户编号。
      if (!req.user) throw publicError(401, '请先登录。', 'AUTH_REQUIRED');
      if (!['admin', 'editor'].includes(req.user.role)) {
        throw publicError(403, '当前账号没有设备维护权限，请联系管理员。', 'ROLE_FORBIDDEN');
      }
      res.set('Cache-Control', 'no-store');
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw publicError(400, '请填写设备信息。', 'INVALID_DEVICE');
      }
      const deviceCode = textField(body, 'deviceCode', '设备码', 80, true);
      const name = textField(body, 'name', '设备名称', 120, true);
      const model = textField(body, 'model', '型号', 120);
      const location = textField(body, 'location', '位置', 200);
      const note = textField(body, 'note', '备注', 10000);
      const coordinates = coordinatesField(body);
      const status = body.status === undefined ? 'active' : body.status;
      if (typeof status !== 'string' || !Object.prototype.hasOwnProperty.call(statusLabels, status)) {
        throw publicError(400, '设备状态不正确。', 'INVALID_DEVICE_STATUS');
      }

      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionOpen = true;
      const columns = 'device_code, name, model, status, location, note, created_by, updated_by';
      const values = [deviceCode, name, model, status, location, note, req.user.id, req.user.id];
      if (coordinates) values.push(coordinates.latitude, coordinates.longitude);
      const [insert] = await connection.query(
        'INSERT INTO devices (' + columns + (coordinates ? ', latitude, longitude' : '') + ') VALUES (' + values.map(() => '?').join(', ') + ')',
        values
      );
      await connection.query(
        "INSERT INTO device_logs (device_id, user_id, action, detail) VALUES (?, ?, 'create', ?)",
        [insert.insertId, req.user.id, JSON.stringify({ deviceCode, name })]
      );
      await connection.commit();
      transactionOpen = false;
      res.status(201).json({
        device: {
          id: insert.insertId, deviceCode, name, model, status,
          statusText: statusLabels[status], location, note, coordinates, images: []
        }
      });
    } catch (error) {
      if (connection && transactionOpen) {
        try { await connection.rollback(); }
        catch (rollbackError) {
          console.error('新增设备事务回滚失败：' + (rollbackError.code || 'UNKNOWN'));
        }
      }
      if (error.publicMessage) {
        res.status(error.status).json({ message: error.publicMessage, code: error.code });
      } else if (error.code === 'ER_BAD_FIELD_ERROR') {
        res.status(503).json({
          message: '设备定位存储尚未启用，请联系管理员升级定位字段后重试。', code: 'DEVICE_LOCATION_NOT_READY'
        });
      } else if (error.code === 'ER_DUP_ENTRY') {
        res.status(409).json({
          message: '已有相同设备码，请先扫码查询该设备。',
          code: 'DEVICE_CODE_EXISTS'
        });
      } else {
        next(error);
      }
    } finally {
      if (connection) connection.release();
    }
  }
  async function update(req, res, next) {
    let connection;
    let transactionOpen = false;
    try {
      if (!req.user) throw publicError(401, '请先登录。', 'AUTH_REQUIRED');
      if (!['admin', 'editor'].includes(req.user.role)) {
        throw publicError(403, '当前账号没有设备维护权限，请联系管理员。', 'ROLE_FORBIDDEN');
      }
      res.set('Cache-Control', 'no-store');
      const deviceCode = textField({ deviceCode: req.params.code }, 'deviceCode', '设备码', 80, true);
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw publicError(400, '请填写设备信息。', 'INVALID_DEVICE');
      }
      if (body.deviceCode !== undefined && body.deviceCode !== deviceCode) {
        throw publicError(400, '设备码不能修改，以免原标签失效。', 'DEVICE_CODE_IMMUTABLE');
      }
      const name = textField(body, 'name', '设备名称', 120, true);
      const model = textField(body, 'model', '型号', 120);
      const location = textField(body, 'location', '位置', 200);
      const note = textField(body, 'note', '备注', 10000);
      const status = body.status;
      if (typeof status !== 'string' || !Object.prototype.hasOwnProperty.call(statusLabels, status)) {
        throw publicError(400, '设备状态不正确。', 'INVALID_DEVICE_STATUS');
      }
      const hasCoordinates = Object.prototype.hasOwnProperty.call(body, 'coordinates');
      const coordinates = coordinatesField(body);
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionOpen = true;
      // 与图片维护使用同一个设备行锁，资料和操作记录一起提交。
      const [rows] = await connection.query(
        'SELECT * FROM devices WHERE device_code = ? AND archived_at IS NULL LIMIT 1 FOR UPDATE', [deviceCode]
      );
      const device = rows[0];
      if (!device) throw publicError(404, '设备不存在或已归档，请返回列表刷新。', 'DEVICE_NOT_FOUND');
      const values = [name, model, status, location, note, req.user.id];
      let assignments = 'name = ?, model = ?, status = ?, location = ?, note = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP';
      if (hasCoordinates) {
        assignments += ', latitude = ?, longitude = ?';
        values.push(coordinates ? coordinates.latitude : null, coordinates ? coordinates.longitude : null);
      }
      values.push(device.id);
      await connection.query('UPDATE devices SET ' + assignments + ' WHERE id = ?', values);
      await connection.query(
        "INSERT INTO device_logs (device_id, user_id, action, detail) VALUES (?, ?, 'update', ?)",
        [device.id, req.user.id, JSON.stringify({
          type: 'device_edit', deviceCode,
          before: { name: device.name, model: device.model, status: device.status, location: device.location,
            note: device.note, latitude: device.latitude, longitude: device.longitude },
          after: { name, model, status, location, note, ...(hasCoordinates ? { coordinates } : {}) }
        })]
      );
      await connection.commit();
      transactionOpen = false;
      res.json({ device: { id: Number(device.id), deviceCode: device.device_code, name, model, status,
        statusText: statusLabels[status], location, note } });
    } catch (error) {
      if (connection && transactionOpen) {
        try { await connection.rollback(); }
        catch (rollbackError) { console.error('编辑设备事务回滚失败：' + (rollbackError.code || 'UNKNOWN')); }
      }
      if (error.publicMessage) res.status(error.status).json({ message: error.publicMessage, code: error.code });
      else if (error.code === 'ER_BAD_FIELD_ERROR') {
        res.status(503).json({ message: '设备定位存储尚未启用，请升级定位字段后重试。', code: 'DEVICE_LOCATION_NOT_READY' });
      } else next(error);
    } finally { if (connection) connection.release(); }
  }
  return { create, update };
}
