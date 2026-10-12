const statusLabels = { active: '正常运行', maintenance: '维护中', retired: '已停用' };

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, publicMessage: message, code: 'INVALID_DEVICE_FILTER' });
}

function integerParam(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw invalid('分页参数不正确。');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) throw invalid('分页参数不正确。');
  return number;
}

export function createDeviceList({ pool }) {
  return async function list(req, res, next) {
    try {
      const q = req.query.q === undefined ? '' : req.query.q;
      if (typeof q !== 'string' || q.length > 120 || /[\u0000-\u001f\u007f]/.test(q)) {
        throw invalid('搜索内容最多 120 个字符。');
      }
      const keyword = q.trim();
      const status = req.query.status === undefined ? '' : req.query.status;
      if (typeof status !== 'string' || status && !Object.prototype.hasOwnProperty.call(statusLabels, status)) {
        throw invalid('设备状态筛选不正确。');
      }
      const page = integerParam(req.query.page, 1, 100000);
      const pageSize = integerParam(req.query.pageSize, 20, 50);
      const clauses = ['d.archived_at IS NULL'];
      const values = [];
      if (keyword) {
        const pattern = '%' + keyword.replace(/[!%_]/g, value => '!' + value) + '%';
        clauses.push("(d.device_code LIKE ? ESCAPE '!' OR d.name LIKE ? ESCAPE '!')");
        values.push(pattern, pattern);
      }
      if (status) { clauses.push('d.status = ?'); values.push(status); }
      const where = ' WHERE ' + clauses.join(' AND ');
      const [counts] = await pool.query('SELECT COUNT(*) AS total FROM devices d' + where, values);
      const [rows] = await pool.query(
        'SELECT d.id, d.device_code AS deviceCode, d.name, d.model, d.status, d.location, d.updated_at AS updatedAt, ' +
        '(SELECT i.object_key FROM device_images i WHERE i.device_id = d.id ORDER BY i.sort_order, i.id LIMIT 1) AS cover ' +
        'FROM devices d' + where + ' ORDER BY d.id DESC LIMIT ? OFFSET ?',
        [...values, pageSize, (page - 1) * pageSize]
      );
      res.set('Cache-Control', 'no-store');
      const total = Number(counts[0].total);
      res.json({ devices: rows.map(device => ({ ...device, statusText: statusLabels[device.status] || device.status })),
        total, page, pageSize, hasMore: page * pageSize < total });
    } catch (error) {
      if (error.publicMessage) res.status(error.status).json({ message: error.publicMessage, code: error.code });
      else next(error);
    }
  };
}
