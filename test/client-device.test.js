import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const requireClient = createRequire(import.meta.url);
const images = requireClient('../../miniprogram/utils/device-images.js');
const plain = value => JSON.parse(JSON.stringify(value));

function setData(patch) {
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let target = this.data;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = value;
  }
}

function pageFixture(overrides = {}) {
  const calls = { creates: [], uploads: [], locations: [], previews: [] };
  const wx = {
    previewImage: options => calls.previews.push(options),
    scanCode: options => { options.success({ result: ' DEMO-NEW ' }); options.complete(); },
    ...overrides.wx
  };
  const dependencies = {
    '../../utils/auth': { getCurrentUser: async () => ({ role: 'admin' }), clearSession() {} },
    '../../utils/device-admin': {
      createDevice: async fields => {
        calls.creates.push(plain(fields));
        return overrides.create ? overrides.create(fields) : { deviceCode: fields.deviceCode };
      }
    },
    '../../utils/device-images': {
      MAX_DEVICE_IMAGES: 10,
      chooseDevicePhotos: async () => overrides.files || [{ path: 'local-1.jpg', size: 12 }],
      uploadDeviceImage: async (code, path) => {
        calls.uploads.push({ code, path });
        return overrides.upload ? overrides.upload(code, path) : { id: calls.uploads.length, url: 'https://example.com/' + path };
      }
    },
    '../../utils/device-location': {
      coordinateText: value => value.latitude.toFixed(6) + ', ' + value.longitude.toFixed(6),
      getCurrentLocation: async () => {
        calls.locations.push('current');
        if (overrides.locationError) throw overrides.locationError;
        return { latitude: 31.23, longitude: 121.47 };
      },
      chooseDeviceLocation: async () => {
        calls.locations.push('map');
        if (overrides.locationError) throw overrides.locationError;
        return { latitude: 31.24, longitude: 121.48, address: '测试地址 · 设备间' };
      }
    }
  };
  let page;
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/add-device/add-device.js', import.meta.url), 'utf8'), {
    wx, require: name => dependencies[name], Page: value => { page = value; }
  });
  page.setData = setData;
  page.setData({ loading: false, allowed: true, 'fields.deviceCode': 'NEW-001', 'fields.name': '新设备' });
  return { page, wx, calls };
}

test('creating with photos saves coordinates and associates each upload with the returned device code', async () => {
  const f = pageFixture({ files: [{ path: 'a.jpg', size: 1 }, { path: 'b.jpg', size: 2 }] });
  await f.page.locateDevice({ currentTarget: { dataset: { mode: 'current' } } });
  await f.page.choosePhotos();
  assert.equal(f.page.data.photoCount, 2);
  assert.equal(f.page.data.photos[0].path, 'a.jpg');
  await f.page.submitDevice();
  assert.deepEqual(f.calls.creates[0].coordinates, { latitude: 31.23, longitude: 121.47 });
  assert.deepEqual(f.calls.uploads, [{ code: 'NEW-001', path: 'a.jpg' }, { code: 'NEW-001', path: 'b.jpg' }]);
  assert.equal(f.page.data.completed, true);
  assert.equal(f.page.data.uploadedCount, 2);
});

test('partial photo upload retries remaining photos without creating the device again', async () => {
  let rejected = false;
  const f = pageFixture({ files: [{ path: 'a.jpg', size: 1 }, { path: 'b.jpg', size: 2 }],
    upload: async (_code, path) => {
      if (path === 'b.jpg' && !rejected) { rejected = true; throw new Error('上传失败'); }
      return { url: 'https://example.com/' + path };
    }
  });
  await f.page.choosePhotos();
  await f.page.submitDevice();
  assert.equal(f.page.data.savedCode, 'NEW-001');
  assert.equal(f.page.data.completed, false);
  assert.equal(f.page.data.uploadedCount, 1);
  await f.page.submitDevice();
  assert.equal(f.calls.creates.length, 1);
  assert.deepEqual(f.calls.uploads.map(call => call.path), ['a.jpg', 'b.jpg', 'b.jpg']);
  assert.equal(f.page.data.completed, true);
});

test('uncertain photo upload stops automatic retries and preserves the saved device', async () => {
  const f = pageFixture({ upload: async () => { throw Object.assign(new Error('超时'), { uncertain: true }); } });
  await f.page.choosePhotos();
  await f.page.submitDevice();
  await f.page.submitDevice();
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.calls.uploads.length, 1);
  assert.equal(f.page.data.savedCode, 'NEW-001');
  assert.equal(f.page.data.uncertainUpload, true);
  assert.equal(f.page.data.photos[0].state, 'uncertain');
});

test('failed device creation does not upload photos and allows another save', async () => {
  let failed = true;
  const f = pageFixture({ create: async fields => {
    if (failed) { failed = false; throw new Error('设备码重复'); }
    return { deviceCode: fields.deviceCode };
  } });
  await f.page.choosePhotos();
  await f.page.submitDevice();
  assert.equal(f.calls.uploads.length, 0);
  assert.equal(f.page.data.submitting, false);
  await f.page.submitDevice();
  assert.equal(f.page.data.completed, true);
});

test('duplicate save clicks only create a single device while the request is pending', async () => {
  let resolveCreate;
  const f = pageFixture({ create: () => new Promise(resolve => { resolveCreate = resolve; }) });
  const pending = f.page.submitDevice();
  await f.page.submitDevice();
  assert.equal(f.calls.creates.length, 1);
  resolveCreate({ deviceCode: 'NEW-001' });
  await pending;
  assert.equal(f.page.data.completed, true);
});

test('location from phone preserves text and map selection updates the address', async () => {
  const f = pageFixture();
  f.page.setData({ 'fields.location': '2F / 设备间' });
  await f.page.locateDevice({ currentTarget: { dataset: { mode: 'current' } } });
  assert.equal(f.page.data.fields.location, '2F / 设备间');
  assert.equal(f.page.data.coordinates.latitude, 31.23);
  await f.page.locateDevice({ currentTarget: { dataset: { mode: 'map' } } });
  assert.equal(f.page.data.fields.location, '测试地址 · 设备间');
  f.page.clearLocation();
  assert.equal(f.page.data.coordinates, null);
  assert.equal(f.page.data.fields.location, '测试地址 · 设备间');
});

test('location denial and cancellation retain the form and unlock the location action', async () => {
  for (const locationError of [Object.assign(new Error('拒绝授权'), { needsSettings: true }),
    Object.assign(new Error('取消'), { cancelled: true })]) {
    const f = pageFixture({ locationError });
    f.page.setData({ 'fields.location': '原位置', coordinates: { latitude: 1, longitude: 2 } });
    await f.page.locateDevice({ currentTarget: { dataset: { mode: 'map' } } });
    assert.equal(f.page.data.fields.location, '原位置');
    assert.equal(f.page.data.coordinates.latitude, 1);
    assert.equal(f.page.data.locating, false);
    assert.equal(f.page.data.needsLocationSettings, !!locationError.needsSettings);
  }
});

test('photo preview and removal work before saving, without losing the form on return', async () => {
  const f = pageFixture();
  await f.page.choosePhotos();
  f.page.previewPhoto({ currentTarget: { dataset: { path: 'local-1.jpg' } } });
  assert.equal(f.calls.previews[0].current, 'local-1.jpg');
  f.page.onShow();
  assert.equal(f.page.data.loading, false);
  f.page.removePhoto({ currentTarget: { dataset: { id: f.page.data.photos[0].id } } });
  assert.equal(f.page.data.photoCount, 0);
});

test('photo selection is limited to ten and unavailable without edit permission', async () => {
  const f = pageFixture();
  f.page.setData({ photos: Array.from({ length: 10 }, (_, id) => ({ id, path: 'a.jpg' })), photoCount: 10 });
  await f.page.choosePhotos();
  assert.equal(f.page.data.photoCount, 10);
  f.page.setData({ allowed: false });
  await f.page.submitDevice();
  assert.equal(f.calls.creates.length, 0);
});

test('gallery normalizes relative URLs, string URLs and image objects, filtering invalid entries', () => {
  const result = images.normalizeDeviceImages([
    '/media/device-images/1/a.jpg', { id: 7, objectKey: '/media/device-images/1/b.png' },
    'https://example.com/c.jpg', null, { url: '' }, 'file:///unsafe.jpg'
  ]);
  assert.equal(result.length, 3);
  assert.match(result[0].url, /^http:\/\/[^/]+\/media\/device-images\/1\/a\.jpg$/);
  assert.equal(result[1].id, 7);
  assert.equal(result[2].src, 'https://example.com/c.jpg');
});

test('thumbnail error recovers through a local image path, then exposes an error after recovery fails', () => {
  const previous = globalThis.wx;
  const page = { data: { images: images.normalizeDeviceImages(['https://example.com/a.jpg']) }, setData };
  let request;
  globalThis.wx = { getImageInfo: options => { request = options; } };
  try {
    const event = { currentTarget: { dataset: { index: 0 } } };
    images.onThumbnailError(page, event);
    request.success({ path: 'wxfile://a.jpg' });
    assert.equal(page.data.images[0].src, 'wxfile://a.jpg');
    images.onThumbnailLoad(page, event);
    assert.equal(page.data.images[0].loading, false);
    images.onThumbnailError(page, event);
    assert.equal(page.data.images[0].failed, true);
  } finally { globalThis.wx = previous; }
});

test('late thumbnail recovery cannot overwrite a different image after gallery refresh', () => {
  const previous = globalThis.wx;
  const page = { data: { images: images.normalizeDeviceImages(['https://example.com/a.jpg']) }, setData };
  let request;
  globalThis.wx = { getImageInfo: options => { request = options; } };
  try {
    images.onThumbnailError(page, { currentTarget: { dataset: { index: 0 } } });
    page.data.images = images.normalizeDeviceImages(['https://example.com/b.jpg']);
    request.success({ path: 'wxfile://a.jpg' });
    assert.equal(page.data.images[0].src, 'https://example.com/b.jpg');
  } finally { globalThis.wx = previous; }
});

test('photo picker falls back to chooseImage and rejects oversize files', async () => {
  const previous = globalThis.wx;
  try {
    globalThis.wx = { chooseImage: options => options.success({ tempFiles: [{ path: 'a.jpg', size: 100 }] }) };
    assert.equal((await images.chooseDevicePhotos())[0].path, 'a.jpg');
    globalThis.wx = { chooseMedia: options => options.success({ tempFiles: [{ tempFilePath: 'a.jpg', size: 6 * 1024 * 1024 }] }) };
    await assert.rejects(images.chooseDevicePhotos(), /5 MB/);
  } finally { globalThis.wx = previous; }
});

test('freshly uploaded photos use the selected local path for visible thumbnails', async () => {
  const previous = globalThis.wx;
  try {
    globalThis.wx = {
      getStorageSync: () => 'token',
      uploadFile: options => options.success({ statusCode: 201, data: JSON.stringify({
        image: { id: 1, url: '/media/device-images/1/a.jpg' }
      }) })
    };
    const image = await images.uploadDeviceImage('NEW-001', 'wxfile://a.jpg');
    assert.equal(image.src, 'wxfile://a.jpg');
    assert.equal(image.loading, false);
    assert.match(image.url, /\/media\/device-images\/1\/a\.jpg$/);
  } finally { globalThis.wx = previous; }
});
