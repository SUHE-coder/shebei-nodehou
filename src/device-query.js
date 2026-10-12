const basicColumns = 'd.id, d.device_code AS deviceCode, d.name, d.model, d.status, d.location, d.note, d.updated_at AS updatedAt';

export function createDeviceQuery({ pool }) {
  return async function queryDevice(req, res, next) {
    try {
      const suffix = ' FROM devices d WHERE d.device_code = ? AND d.archived_at IS NULL LIMIT 1';
      let rows;
      try {
        [rows] = await pool.query('SELECT ' + basicColumns + ', d.latitude, d.longitude' + suffix, [req.params.code]);
      } catch (error) {
        // 旧数据库尚未升级时，原有扫码查询仍可用。
        if (error.code !== 'ER_BAD_FIELD_ERROR') throw error;
        [rows] = await pool.query('SELECT ' + basicColumns + suffix, [req.params.code]);
      }
      if (!rows.length) return res.status(404).json({ message: 'device not found' });
      const device = rows[0];
      const [images] = await pool.query(
        'SELECT object_key AS objectKey, id FROM device_images WHERE device_id = ? ORDER BY sort_order, id', [device.id]
      );
      const hasCoordinates = device.latitude !== null && device.longitude !== null
        && device.latitude !== undefined && device.longitude !== undefined;
      const latitude = Number(device.latitude);
      const longitude = Number(device.longitude);
      const coordinates = hasCoordinates && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
        && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 ? { latitude, longitude } : null;
      const statusText = { active: '正常运行', maintenance: '维护中', retired: '已停用' }[device.status] || device.status;
      res.json({ ...device, coordinates, statusText, images: images.map(image => image.objectKey),
        imageRecords: images.map(image => ({ id: Number(image.id), objectKey: image.objectKey })) });
    } catch (error) { next(error); }
  };
}
