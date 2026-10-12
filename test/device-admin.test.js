import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceAdmin } from '../src/device-admin.js';

function fixture({ role = 'admin', insertError = null, logError = null, poolError = null } = {}) {
  const state = { acquisitions: 0, events: [], queries: [], devices: [], logs: [] };
  let stagedDevice = null;
  let stagedLog = null;
  const connection = {
    async beginTransaction() { state.events.push('begin'); },
    async query(sql, params) {
      state.queries.push({ sql, params });
      if (sql.startsWith('INSERT INTO devices ')) {
        if (insertError) throw insertError;
        stagedDevice = { id: 17, params };
        return [{ insertId: 17 }];
      }
      if (sql.startsWith('INSERT INTO device_logs ')) {
        if (logError) throw logError;
        stagedLog = { params };
        return [{ affectedRows: 1 }];
      }
      throw new Error('Unexpected query: ' + sql);
    },
    async commit() {
      state.events.push('commit');
      if (stagedDevice) state.devices.push(stagedDevice);
      if (stagedLog) state.logs.push(stagedLog);
    },
    async rollback() {
      state.events.push('rollback');
      stagedDevice = null;
      stagedLog = null;
    },
    release() { state.events.push('release'); }
  };
  const pool = {
    async getConnection() {
      state.acquisitions++;
      if (poolError) throw poolError;
      return connection;
    }
  };
  const req = {
    user: role ? { id: 2, role } : null,
    body: { deviceCode: '  DEMO-002  ', name: '二号设备', location: '一号楼 / 3F', note: '巡检周期：每月' }
  };
  const res = {
    statusCode: 200,
    headers: {},
    set(key, value) { this.headers[key] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
  let forwarded;
  const handler = createDeviceAdmin({ pool }).create;
  return { state, req, res, run: () => handler(req, res, error => { forwarded = error; }), error: () => forwarded };
}

test('admin creates a device and log atomically using the authenticated user ID', async () => {
  const f = fixture();
  Object.assign(f.req.body, { createdBy: 999, updatedBy: 999, userId: 999, role: 'admin' });
  await f.run();
  assert.equal(f.res.statusCode, 201);
  assert.equal(f.res.body.device.deviceCode, 'DEMO-002');
  assert.equal(f.res.body.device.status, 'active');
  assert.equal(f.state.queries[0].params[6], 2);
  assert.equal(f.state.queries[0].params[7], 2);
  assert.equal(f.state.logs[0].params[1], 2);
  assert.deepEqual(JSON.parse(f.state.logs[0].params[2]), { deviceCode: 'DEMO-002', name: '二号设备' });
  assert.deepEqual(f.state.events, ['begin', 'commit', 'release']);
  assert.equal(f.res.headers['Cache-Control'], 'no-store');
  assert.equal(f.error(), undefined);
});

test('editor can create a device', async () => {
  const f = fixture({ role: 'editor' });
  await f.run();
  assert.equal(f.res.statusCode, 201);
  assert.equal(f.state.devices.length, 1);
});

test('viewers and unauthenticated callers cannot create devices', async () => {
  for (const [role, status] of [['viewer', 403], [null, 401]]) {
    const f = fixture({ role });
    f.req.body.role = 'admin';
    await f.run();
    assert.equal(f.res.statusCode, status);
    assert.equal(f.state.acquisitions, 0);
  }
});

test('invalid input is rejected before acquiring a database connection', async () => {
  const invalidInputs = [
    { deviceCode: '' }, { deviceCode: 'x'.repeat(81) }, { name: ' ' },
    { name: 'x'.repeat(121) }, { location: 'x'.repeat(201) },
    { note: 'x'.repeat(10001) }, { model: 12 }, { deviceCode: 'CODE\n002' },
    { name: 'name\u0000' }, { status: 'constructor' }, { status: '__proto__' },
    { status: null }
  ];
  for (const invalid of invalidInputs) {
    const f = fixture();
    Object.assign(f.req.body, invalid);
    await f.run();
    assert.equal(f.res.statusCode, 400);
    assert.equal(f.state.acquisitions, 0);
  }
});

test('duplicate device code returns 409 and rolls back', async () => {
  const f = fixture({ insertError: Object.assign(new Error('private duplicate value'), { code: 'ER_DUP_ENTRY' }) });
  await f.run();
  assert.equal(f.res.statusCode, 409);
  assert.equal(f.res.body.code, 'DEVICE_CODE_EXISTS');
  assert.equal(f.state.devices.length, 0);
  assert.equal(f.state.logs.length, 0);
  assert.deepEqual(f.state.events, ['begin', 'rollback', 'release']);
  assert.ok(!JSON.stringify(f.res.body).includes('private duplicate value'));
});

test('log failure rolls back the device and forwards the error', async () => {
  const logError = Object.assign(new Error('log failure'), { code: 'ER_SERVER_SHUTDOWN' });
  const f = fixture({ logError });
  await f.run();
  assert.equal(f.error(), logError);
  assert.equal(f.res.body, undefined);
  assert.equal(f.state.devices.length, 0);
  assert.equal(f.state.logs.length, 0);
  assert.deepEqual(f.state.events, ['begin', 'rollback', 'release']);
});

test('database acquisition failure does not pretend a device was saved', async () => {
  const poolError = Object.assign(new Error('database down'), { code: 'ECONNREFUSED' });
  const f = fixture({ poolError });
  await f.run();
  assert.equal(f.error(), poolError);
  assert.equal(f.res.body, undefined);
  assert.equal(f.state.devices.length, 0);
  assert.deepEqual(f.state.events, []);
});

test('SQL values are parameters and optional blank fields become null', async () => {
  const f = fixture();
  f.req.body.deviceCode = "CODE'); DROP TABLE users;--";
  f.req.body.name = "泵'站";
  f.req.body.model = ' ';
  f.req.body.note = '第一行\n第二行';
  f.req.body.status = 'maintenance';
  await f.run();
  assert.equal(f.res.statusCode, 201);
  assert.equal(f.state.queries[0].params[0], f.req.body.deviceCode);
  assert.ok(!f.state.queries[0].sql.includes(f.req.body.deviceCode));
  assert.equal(f.state.queries[0].params[2], null);
  assert.equal(f.state.queries[0].params[5], f.req.body.note);
  assert.equal(f.res.body.device.statusText, '维修中');
});

test('device coordinates are validated, stored and returned, including zero coordinates', async () => {
  for (const coordinates of [{ latitude: 31.2304, longitude: 121.4737 }, { latitude: 0, longitude: 0 }]) {
    const f = fixture();
    f.req.body.coordinates = coordinates;
    await f.run();
    assert.equal(f.res.statusCode, 201);
    assert.equal(f.state.queries[0].params[8], coordinates.latitude);
    assert.equal(f.state.queries[0].params[9], coordinates.longitude);
    assert.deepEqual(f.res.body.device.coordinates, coordinates);
  }
});

test('missing location remains null instead of recording a zero coordinate', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.res.body.device.coordinates, null);
  assert.equal(f.state.queries[0].params.length, 8);
  assert.ok(!f.state.queries[0].sql.includes('latitude'));
});

test('invalid and incomplete coordinates are rejected before database access', async () => {
  for (const coordinates of ['', [], {}, { latitude: null, longitude: null },
    { latitude: '31', longitude: 121 }, { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: -181 }, { latitude: NaN, longitude: 0 },
    { latitude: Infinity, longitude: 0 }, { latitude: 31 }]) {
    const f = fixture();
    f.req.body.coordinates = coordinates;
    await f.run();
    assert.equal(f.res.statusCode, 400);
    assert.equal(f.state.acquisitions, 0);
  }
});

test('an old database returns an actionable error and rolls back a save with coordinates', async () => {
  const f = fixture({ insertError: Object.assign(new Error('Unknown column'), { code: 'ER_BAD_FIELD_ERROR' }) });
  f.req.body.coordinates = { latitude: 31, longitude: 121 };
  await f.run();
  assert.equal(f.res.statusCode, 503);
  assert.equal(f.res.body.code, 'DEVICE_LOCATION_NOT_READY');
  assert.deepEqual(f.state.events, ['begin', 'rollback', 'release']);
});
