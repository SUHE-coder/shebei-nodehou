import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceQuery } from '../src/device-query.js';

function fixture({ coordinates = { latitude: '31.2304000', longitude: '121.4737000' }, oldSchema = false, missing = false, failure = null } = {}) {
  const calls = [];
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    if (failure) throw failure;
    if (oldSchema && sql.includes('d.latitude')) throw Object.assign(new Error('missing field'), { code: 'ER_BAD_FIELD_ERROR' });
    if (sql.startsWith('SELECT object_key')) return [[{ objectKey: '/media/device-images/1/a.jpg' }]];
    return [missing ? [] : [{ id: 1, deviceCode: 'DEVICE-001', name: '测试设备', status: 'active', ...(oldSchema ? {} : coordinates) }]];
  } };
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  let forwarded;
  return { res, calls, error: () => forwarded,
    run: () => createDeviceQuery({ pool })({ params: { code: 'DEVICE-001' } }, res, error => { forwarded = error; }) };
}

test('query returns numeric coordinates from MySQL DECIMAL strings and ordered photo URLs', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.res.body.coordinates, { latitude: 31.2304, longitude: 121.4737 });
  assert.deepEqual(f.res.body.images, ['/media/device-images/1/a.jpg']);
});

test('null and invalid coordinates do not produce a location on the map', async () => {
  for (const coordinates of [{ latitude: null, longitude: null }, { latitude: 'NaN', longitude: 121 },
    { latitude: 91, longitude: 121 }, { latitude: 31, longitude: null }]) {
    const f = fixture({ coordinates });
    await f.run();
    assert.equal(f.res.body.coordinates, null);
  }
});

test('old databases keep device and image queries working before the location migration', async () => {
  const f = fixture({ oldSchema: true });
  await f.run();
  assert.equal(f.res.body.deviceCode, 'DEVICE-001');
  assert.equal(f.res.body.coordinates, null);
  assert.equal(f.res.body.images.length, 1);
  assert.equal(f.calls.length, 3);
});

test('missing devices return 404 and database outages are forwarded', async () => {
  const missing = fixture({ missing: true });
  await missing.run();
  assert.equal(missing.res.statusCode, 404);
  const failure = Object.assign(new Error('database disconnected'), { code: 'PROTOCOL_CONNECTION_LOST' });
  const failed = fixture({ failure });
  await failed.run();
  assert.equal(failed.error(), failure);
  assert.equal(failed.res.body, undefined);
});
