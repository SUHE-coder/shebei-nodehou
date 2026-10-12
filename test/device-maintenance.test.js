import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceAdmin } from '../src/device-admin.js';
import { createDeviceImages } from '../src/device-images.js';

function fixture({ role = 'admin', missing = false, noImage = false, failAt = '',
  objectKey = '/media/device-images/17/' + 'a'.repeat(36) + '.jpg' } = {}) {
  const original = { id: 17, device_code: 'DEMO-001', name: '原设备', model: 'A', status: 'active',
    location: '原位置', note: '原备注', latitude: 31, longitude: 121 };
  const state = { events: [], queries: [], acquisitions: 0, deleted: false, saved: false, logs: [] };
  const problem = new Error('database error');
  let stagedEdit = false;
  let stagedDelete = false;
  let stagedLogs = [];
  const connection = {
    async beginTransaction() { state.events.push('begin'); },
    async query(sql, params) {
      state.queries.push({ sql, params });
      if (sql.startsWith('SELECT') && sql.includes('FROM devices WHERE')) return [missing ? [] : [original]];
      if (sql.startsWith('SELECT') && sql.includes('FROM device_images')) return [noImage ? [] : [{ objectKey }]];
      if (sql.startsWith('UPDATE devices')) { if (failAt === 'edit') throw problem; stagedEdit = true; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('DELETE FROM device_images')) { if (failAt === 'delete') throw problem; stagedDelete = true; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('INSERT INTO device_logs')) {
        if (failAt === 'log') throw problem;
        stagedLogs.push(params); return [{ insertId: 1 }];
      }
      throw new Error('Unexpected query: ' + sql);
    },
    async commit() {
      state.events.push('commit'); if (failAt === 'commit') throw problem;
      state.saved = stagedEdit; state.deleted = stagedDelete; state.logs = stagedLogs;
    },
    async rollback() { state.events.push('rollback'); stagedEdit = false; stagedDelete = false; stagedLogs = []; },
    release() { state.events.push('release'); }
  };
  const pool = { async getConnection() { state.acquisitions++; return connection; } };
  const files = { async unlink(filename) { state.events.push('unlink'); state.unlinked = filename; } };
  const req = { user: role ? { id: 2, role } : null, params: { code: 'DEMO-001', imageId: '9' },
    body: { deviceCode: 'DEMO-001', name: "新设备'", model: '', status: 'maintenance', location: '新位置', note: '新备注',
      coordinates: { latitude: 0, longitude: 0 }, updatedBy: 999, role: 'admin' } };
  const res = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let forwarded;
  const next = error => { forwarded = error; };
  return { state, req, res, files, problem, error: () => forwarded,
    edit: () => createDeviceAdmin({ pool }).update(req, res, next),
    remove: () => createDeviceImages({ pool, files, uploadRoot: 'uploads/device-images' }).remove(req, res, next) };
}

test('admin and editor edit existing records and audit changes using authenticated identity', async () => {
  for (const role of ['admin', 'editor']) {
    const f = fixture({ role }); await f.edit();
    assert.equal(f.res.statusCode, 200);
    assert.equal(f.res.body.device.deviceCode, 'DEMO-001');
    const update = f.state.queries.find(query => query.sql.startsWith('UPDATE'));
    assert.equal(update.params[5], 2);
    assert.deepEqual(update.params.slice(6), [0, 0, 17]);
    assert.equal(update.params[1], null);
    assert.ok(!update.sql.includes(f.req.body.name));
    assert.equal(f.state.logs[0][1], 2);
    const log = JSON.parse(f.state.logs[0][2]);
    assert.equal(log.before.name, '原设备'); assert.equal(log.after.name, f.req.body.name);
    assert.deepEqual(f.state.events, ['begin', 'commit', 'release']);
  }
});

test('viewer and unauthenticated clients cannot edit or remove photos even with forged roles', async () => {
  for (const [role, expected] of [['viewer', 403], [null, 401]]) {
    for (const action of ['edit', 'remove']) {
      const f = fixture({ role }); await f[action]();
      assert.equal(f.res.statusCode, expected); assert.equal(f.state.acquisitions, 0);
      assert.ok(!f.state.events.includes('unlink'));
    }
  }
});

test('device label code is immutable and invalid edits never acquire a connection', async () => {
  for (const values of [{ deviceCode: 'OTHER' }, { name: ' ' }, { note: 'x'.repeat(10001) },
    { status: '__proto__' }, { coordinates: { latitude: 91, longitude: 0 } }]) {
    const f = fixture(); Object.assign(f.req.body, values); await f.edit();
    assert.equal(f.res.statusCode, 400); assert.equal(f.state.acquisitions, 0);
  }
});

test('coordinates can be cleared explicitly and are preserved when omitted', async () => {
  const cleared = fixture(); cleared.req.body.coordinates = null; await cleared.edit();
  assert.deepEqual(cleared.state.queries.find(query => query.sql.startsWith('UPDATE')).params.slice(6), [null, null, 17]);
  const unchanged = fixture(); delete unchanged.req.body.coordinates; await unchanged.edit();
  assert.ok(!unchanged.state.queries.find(query => query.sql.startsWith('UPDATE')).sql.includes('latitude'));
});

test('missing or archived devices return 404 without committing edits or photo deletion', async () => {
  for (const action of ['edit', 'remove']) {
    const f = fixture({ missing: true }); await f[action]();
    assert.equal(f.res.statusCode, 404);
    assert.deepEqual(f.state.events, ['begin', 'rollback', 'release']);
  }
});

test('edit and audit failures roll back the saved record', async () => {
  for (const failAt of ['edit', 'log', 'commit']) {
    const f = fixture({ failAt }); await f.edit();
    assert.equal(f.error(), f.problem); assert.equal(f.state.saved, false);
    assert.equal(f.res.body, undefined); assert.ok(f.state.events.includes('rollback'));
  }
});

test('photo deletion is scoped to the selected device and only removes the file after commit', async () => {
  const f = fixture(); await f.remove();
  assert.equal(f.res.body.ok, true);
  assert.deepEqual(f.state.queries.find(query => query.sql.startsWith('DELETE')).params, [9, 17]);
  assert.deepEqual(f.state.events, ['begin', 'commit', 'unlink', 'release']);
  assert.equal(f.state.logs[0][1], 2);
  assert.equal(JSON.parse(f.state.logs[0][2]).type, 'image_remove');
});

test('already deleted or foreign-device photo IDs do not affect other images', async () => {
  const f = fixture({ noImage: true }); await f.remove();
  assert.equal(f.res.body.ok, true); assert.equal(f.state.deleted, false);
  assert.equal(f.state.logs.length, 0); assert.ok(!f.state.events.includes('unlink'));
});

test('delete and audit failures preserve photo files and roll back the database', async () => {
  for (const failAt of ['delete', 'log', 'commit']) {
    const f = fixture({ failAt }); await f.remove();
    assert.equal(f.error(), f.problem); assert.equal(f.state.deleted, false);
    assert.ok(!f.state.events.includes('unlink')); assert.ok(f.state.events.includes('rollback'));
  }
});

test('untrusted stored paths cannot cause filesystem deletion outside the upload directory', async () => {
  for (const objectKey of ['/media/device-images/17/../../secret.jpg',
    '/media/device-images/18/' + 'a'.repeat(36) + '.jpg', 'https://example.com/a.jpg']) {
    const f = fixture({ objectKey }); await f.remove();
    assert.equal(f.res.body.ok, true); assert.ok(!f.state.events.includes('unlink'));
  }
});

test('invalid image IDs are rejected before database access', async () => {
  for (const imageId of ['0', '-1', 'abc', '1 OR 1=1', '9007199254740993']) {
    const f = fixture(); f.req.params.imageId = imageId; await f.remove();
    assert.equal(f.res.statusCode, 400); assert.equal(f.state.acquisitions, 0);
  }
});
