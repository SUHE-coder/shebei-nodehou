import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceImages, detectImage } from '../src/device-images.js';

function fixture({ role = 'admin', missingDevice = false, imageCount = 0, failAt = '', mime = 'image/jpeg' } = {}) {
  const state = { events: [], queries: [], acquisitions: 0, files: new Map(), committedImages: [] };
  const problem = Object.assign(new Error('private storage or database detail'), { code: 'TEST_FAILURE' });
  let stagedImage;
  const connection = {
    async beginTransaction() { state.events.push('begin'); },
    async query(sql, params) {
      state.queries.push({ sql, params });
      if (sql.startsWith('SELECT id FROM devices')) return [missingDevice ? [] : [{ id: 17 }]];
      if (sql.startsWith('SELECT COUNT(*)')) return [[{ imageCount, sortOrder: imageCount }]];
      if (sql.startsWith('INSERT INTO device_images')) {
        if (failAt === 'image') throw problem;
        stagedImage = params; return [{ insertId: 31 }];
      }
      if (sql.startsWith('INSERT INTO device_logs')) {
        if (failAt === 'log') throw problem;
        return [{ affectedRows: 1 }];
      }
      throw new Error('unexpected query');
    },
    async commit() {
      if (failAt === 'commit') throw problem;
      state.events.push('commit'); state.committedImages.push(stagedImage);
    },
    async rollback() { state.events.push('rollback'); stagedImage = null; },
    release() { state.events.push('release'); }
  };
  const files = {
    async mkdir() { state.events.push('mkdir'); },
    async open(filename, flags) {
      state.events.push('open');
      assert.equal(flags, 'wx');
      if (failAt === 'open') throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      state.files.set(filename, null);
      return {
        async writeFile(buffer) {
          state.events.push('write');
          if (failAt === 'write') throw problem;
          state.files.set(filename, buffer);
        },
        async close() { state.events.push('close'); }
      };
    },
    async unlink(filename) { state.events.push('unlink'); state.files.delete(filename); }
  };
  const pool = { async getConnection() { state.acquisitions++; return connection; } };
  const req = {
    user: role ? { id: 2, role } : null,
    params: { code: 'DEMO-002' },
    file: { buffer: Buffer.from([255, 216, 255, 224, 1, 2]), mimetype: mime, originalname: '../unsafe.jpg' }
  };
  const res = {
    statusCode: 200,
    headers: {},
    set(key, value) { this.headers[key] = value; return this; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; }
  };
  let forwarded;
  const controller = createDeviceImages({
    pool, uploadRoot: '/workspace/uploads', files,
    makeFilename: extension => 'a'.repeat(36) + '.' + extension
  });
  return { state, req, res, problem, run: () => controller.add(req, res, error => { forwarded = error; }), error: () => forwarded };
}

test('image signatures accept JPEG, PNG, WEBP and reject unrelated content', () => {
  assert.equal(detectImage(Buffer.from([255, 216, 255])), 'jpg');
  assert.equal(detectImage(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'png');
  assert.equal(detectImage(Buffer.from('RIFF1234WEBP')), 'webp');
  assert.equal(detectImage(Buffer.from('<svg></svg>')), null);
});

test('admin image upload stores generated key and authenticated audit user', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.res.statusCode, 201);
  assert.equal(f.state.files.size, 1);
  assert.equal(f.state.committedImages.length, 1);
  assert.equal(f.res.body.image.objectKey, '/media/device-images/17/' + 'a'.repeat(36) + '.jpg');
  assert.ok(!f.res.body.image.objectKey.includes('unsafe'));
  const log = f.state.queries.find(query => query.sql.startsWith('INSERT INTO device_logs'));
  assert.equal(log.params[1], 2);
  assert.equal(JSON.parse(log.params[2]).type, 'image_add');
  assert.ok(f.state.queries[0].sql.endsWith('FOR UPDATE'));
  assert.equal(f.state.events[0], 'begin');
  assert.equal(f.state.events.at(-1), 'release');
});

test('editor can upload and generic binary content type still requires an image signature', async () => {
  const f = fixture({ role: 'editor', mime: 'application/octet-stream' });
  await f.run();
  assert.equal(f.res.statusCode, 201);
});

test('viewer and unauthenticated caller cannot create files', async () => {
  for (const [role, expected] of [['viewer', 403], [null, 401]]) {
    const f = fixture({ role });
    await f.run();
    assert.equal(f.res.statusCode, expected);
    assert.equal(f.state.acquisitions, 0);
    assert.equal(f.state.files.size, 0);
  }
});

test('missing, unsupported and oversized images are rejected before database access', async () => {
  for (const input of ['missing', 'signature', 'mismatch', 'large']) {
    const f = fixture();
    if (input === 'missing') f.req.file = null;
    if (input === 'signature') f.req.file.buffer = Buffer.from('not an image');
    if (input === 'mismatch') f.req.file.mimetype = 'image/png';
    if (input === 'large') f.req.file.buffer = Buffer.alloc(5 * 1024 * 1024 + 1);
    await f.run();
    assert.equal(f.res.statusCode, input === 'large' ? 413 : 400);
    assert.equal(f.state.acquisitions, 0);
  }
});

test('missing device rolls back without writing a file', async () => {
  const f = fixture({ missingDevice: true });
  await f.run();
  assert.equal(f.res.statusCode, 404);
  assert.equal(f.state.files.size, 0);
  assert.deepEqual(f.state.events, ['begin', 'rollback', 'release']);
});

test('image count limit prevents writing additional files', async () => {
  const f = fixture({ imageCount: 10 });
  await f.run();
  assert.equal(f.res.statusCode, 409);
  assert.equal(f.res.body.code, 'DEVICE_IMAGE_LIMIT');
  assert.equal(f.state.files.size, 0);
});

test('partial write, image insert, log and commit failures clean the newly created file', async () => {
  for (const failAt of ['write', 'image', 'log', 'commit']) {
    const f = fixture({ failAt });
    await f.run();
    assert.equal(f.error(), f.problem);
    assert.equal(f.state.files.size, 0);
    assert.equal(f.state.committedImages.length, 0);
    assert.ok(f.state.events.includes('rollback'));
    assert.ok(f.state.events.includes('unlink'));
    assert.equal(f.state.events.at(-1), 'release');
  }
});

test('exclusive-create collision never removes an existing file', async () => {
  const f = fixture({ failAt: 'open' });
  await f.run();
  assert.equal(f.error().code, 'EEXIST');
  assert.ok(!f.state.events.includes('unlink'));
  assert.ok(f.state.events.includes('rollback'));
});
