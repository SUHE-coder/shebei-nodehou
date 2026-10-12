import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceList } from '../src/device-list.js';

function fixture(query = {}, error = null) {
  const calls = [];
  const pool = { async query(sql, params) {
    calls.push({ sql, params }); if (error) throw error;
    if (sql.startsWith('SELECT COUNT')) return [[{ total: 41 }]];
    return [[{ id: 1, name: '测试设备', deviceCode: 'TEST-001', status: 'maintenance', cover: null }]];
  } };
  const res = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let forwarded;
  return { calls, res, error: () => forwarded,
    run: () => createDeviceList({ pool })({ query }, res, value => { forwarded = value; }) };
}

test('default listing is paginated, ordered and excludes archived devices', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.res.body.total, 41); assert.equal(f.res.body.page, 1);
  assert.equal(f.res.body.hasMore, true); assert.equal(f.res.body.devices[0].statusText, '维护中');
  assert.ok(f.calls.every(query => query.sql.includes('d.archived_at IS NULL')));
  assert.match(f.calls[1].sql, /ORDER BY d.id DESC LIMIT \? OFFSET \?/);
  assert.deepEqual(f.calls[1].params, [20, 0]);
});

test('search matches codes and names with literal wildcard characters and bound parameters', async () => {
  const f = fixture({ q: "泵_10%! ' OR 1=1 --", status: 'maintenance', page: '2', pageSize: '20' });
  await f.run();
  assert.equal(f.res.statusCode, 200);
  assert.deepEqual(f.calls[1].params, ["%泵!_10!%!! ' OR 1=1 --%", "%泵!_10!%!! ' OR 1=1 --%", 'maintenance', 20, 20]);
  assert.ok(!f.calls[1].sql.includes("OR 1=1 --"));
  assert.equal(f.calls[0].params.length, 3);
});

test('last page reports no further results and invalid filters never query the database', async () => {
  const last = fixture({ page: '3' }); await last.run(); assert.equal(last.res.body.hasMore, false);
  for (const query of [{ q: ['a', 'b'] }, { q: 'x'.repeat(121) }, { q: 'a\n' },
    { status: '__proto__' }, { page: '0' }, { page: '-1' }, { page: '2.5' },
    { pageSize: '51' }, { pageSize: ['20'] }]) {
    const f = fixture(query); await f.run(); assert.equal(f.res.statusCode, 400); assert.equal(f.calls.length, 0);
  }
});

test('database failures are forwarded instead of returning an empty device inventory', async () => {
  const error = new Error('disconnected'); const f = fixture({}, error); await f.run();
  assert.equal(f.error(), error); assert.equal(f.res.body, undefined);
});
