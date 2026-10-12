import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));
function setData(patch) {
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let target = this.data;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = value;
  }
}

function editFixture({ role = 'admin', confirm = true, deleteImage = null } = {}) {
  const calls = { creates: [], edits: [], deletes: [], uploads: [], events: [], reads: 0 };
  const device = { deviceCode: 'DEMO-001', name: '原设备', model: '原型号', status: 'maintenance',
    location: '原位置', note: '原备注', coordinates: { latitude: 31, longitude: 121 },
    images: [{ id: 9, url: 'https://example.com/a.jpg' }, { id: 10, url: 'https://example.com/b.jpg' }] };
  const dependencies = {
    '../../utils/auth': { getCurrentUser: async () => role ? { role } : null, clearSession() {} },
    '../../utils/device-admin': {
      createDevice: async fields => { calls.creates.push(fields); return { deviceCode: fields.deviceCode }; },
      updateDevice: async (code, fields) => {
        calls.edits.push({ code, fields: plain(fields) }); calls.events.push('edit'); return { deviceCode: code };
      }
    },
    '../../utils/device-images': {
      MAX_DEVICE_IMAGES: 10,
      getDeviceImages: async () => { calls.reads++; return device; },
      chooseDevicePhotos: async () => [{ path: 'new.jpg', size: 12 }],
      uploadDeviceImage: async (code, path) => {
        calls.uploads.push({ code, path }); calls.events.push('upload'); return { id: 11 };
      },
      deleteDeviceImage: async (code, id) => {
        calls.deletes.push({ code, id }); calls.events.push('delete-' + id);
        if (deleteImage) await deleteImage(id);
        return { ok: true, imageId: id };
      }, onThumbnailLoad() {}, onThumbnailError() {}
    },
    '../../utils/device-location': { coordinateText: () => '31, 121' }
  };
  let page;
  const wx = { setNavigationBarTitle() {},
    showModal(options) { options.success({ confirm }); options.complete(); } };
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/add-device/add-device.js', import.meta.url), 'utf8'), {
    wx, require: name => dependencies[name], Page: value => { page = value; }
  });
  page.setData = setData;
  page.onLoad({ code: 'DEMO-001' });
  return { page, calls, device };
}

test('edit form loads existing metadata, coordinates and photos without changing device code', async () => {
  const f = editFixture(); await f.page.onShow();
  assert.equal(f.page.data.editing, true); assert.equal(f.page.data.allowed, true);
  assert.equal(f.page.data.fields.name, '原设备'); assert.equal(f.page.data.statusIndex, 1);
  assert.equal(f.page.data.photos[0].state, 'existing'); assert.equal(f.page.data.photos[0].id, 9);
  assert.deepEqual(plain(f.page.data.coordinates), { latitude: 31, longitude: 121 });
  f.page.onFieldInput({ currentTarget: { dataset: { field: 'deviceCode' } }, detail: { value: 'CHANGED' } });
  assert.equal(f.page.data.fields.deviceCode, 'DEMO-001');
});

test('saving edited metadata does not create a device or reupload existing photos', async () => {
  const f = editFixture(); await f.page.onShow();
  f.page.setData({ 'fields.name': '更新名称', 'fields.note': '更新备注' });
  await f.page.submitDevice();
  assert.equal(f.calls.creates.length, 0); assert.equal(f.calls.edits.length, 1);
  assert.equal(f.calls.edits[0].fields.name, '更新名称'); assert.equal(f.calls.uploads.length, 0);
  assert.equal(f.page.data.completed, true);
});

test('existing photo removal is staged until save; deletion occurs before replacement upload', async () => {
  const f = editFixture(); await f.page.onShow();
  f.page.removePhoto({ currentTarget: { dataset: { id: '9' } } });
  assert.equal(f.calls.deletes.length, 0); assert.deepEqual(plain(f.page.data.deletedImageIds), [9]);
  await f.page.choosePhotos(); await f.page.submitDevice();
  assert.deepEqual(f.calls.events, ['edit', 'delete-9', 'upload']);
  assert.deepEqual(f.calls.uploads, [{ code: 'DEMO-001', path: 'new.jpg' }]);
  assert.equal(f.page.data.photoCount, 2); assert.equal(f.page.data.completed, true);
});

test('canceling photo removal preserves the existing gallery', async () => {
  const f = editFixture({ confirm: false }); await f.page.onShow();
  f.page.removePhoto({ currentTarget: { dataset: { id: 9 } } });
  assert.equal(f.page.data.photoCount, 2); assert.equal(f.page.data.deletedImageIds.length, 0);
  assert.equal(f.page.data.choosing, false);
});

test('partial photo deletion retries remaining work without resaving metadata or repeating successful deletions', async () => {
  let failed = false;
  const f = editFixture({ deleteImage: async id => {
    if (id === 10 && !failed) { failed = true; throw new Error('网络失败'); }
  } });
  await f.page.onShow();
  for (const id of [9, 10]) f.page.removePhoto({ currentTarget: { dataset: { id } } });
  await f.page.choosePhotos(); await f.page.submitDevice();
  assert.equal(f.page.data.completed, false); assert.equal(f.page.data.savedCode, 'DEMO-001');
  assert.deepEqual(plain(f.page.data.deletedImageIds), [10]); assert.equal(f.calls.uploads.length, 0);
  await f.page.submitDevice();
  assert.equal(f.calls.edits.length, 1); assert.deepEqual(f.calls.deletes.map(call => call.id), [9, 10, 10]);
  assert.equal(f.page.data.completed, true);
});

test('returning to edit form preserves unsaved changes and viewer cannot submit', async () => {
  const f = editFixture(); await f.page.onShow();
  f.page.setData({ 'fields.note': '尚未保存的备注' }); await f.page.onShow();
  assert.equal(f.page.data.fields.note, '尚未保存的备注'); assert.equal(f.calls.reads, 1);
  for (const role of ['viewer', null]) {
    const viewer = editFixture({ role }); await viewer.page.onShow(); await viewer.page.submitDevice();
    assert.equal(viewer.page.data.allowed, false); assert.equal(viewer.calls.edits.length, 0);
  }
});

function listFixture(request) {
  const calls = [];
  const dependencies = {
    '../../utils/auth': { getCurrentUser: async () => ({ role: 'viewer' }) },
    '../../utils/device-admin': { listDevices: filters => { calls.push(plain(filters)); return request(filters); } },
    '../../utils/device-images': { imageUrl: value => value || '', onThumbnailLoad() {}, onThumbnailError() {} }
  };
  let page;
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/device-list/device-list.js', import.meta.url), 'utf8'), {
    require: name => dependencies[name], Page: value => { page = value; }
  });
  page.setData = setData; return { page, calls };
}

test('a late list response cannot overwrite newer search results', async () => {
  let resolveOld;
  const f = listFixture(filters => filters.q ? Promise.resolve({ devices: [{ id: 2, name: '新结果' }], total: 1, page: 1, hasMore: false })
    : new Promise(resolve => { resolveOld = resolve; }));
  const old = f.page.loadDevices();
  f.page.setData({ keyword: '新结果' }); await f.page.search();
  resolveOld({ devices: [{ id: 1, name: '旧结果' }], total: 1, page: 1, hasMore: false }); await old;
  assert.equal(f.page.data.devices[0].name, '新结果'); assert.equal(f.page.data.loading, false);
});

test('list pagination retains active filters and failed next page can be retried', async () => {
  let failed = false;
  const f = listFixture(async filters => {
    if (filters.page === 2 && !failed) { failed = true; throw new Error('网络失败'); }
    return { devices: [{ id: filters.page, name: '设备' }], total: 21, page: filters.page, hasMore: filters.page === 1 };
  });
  f.page.setData({ keyword: '泵', statusIndex: 2 }); await f.page.search(); await f.page.loadMore();
  assert.equal(f.page.data.devices.length, 1); assert.equal(f.page.data.page, 1);
  await f.page.retry();
  assert.equal(f.page.data.devices.length, 2); assert.equal(f.page.data.page, 2);
  assert.deepEqual(f.calls.map(call => call.page), [1, 2, 2]);
  assert.ok(f.calls.every(call => call.q === '泵' && call.status === 'maintenance'));
});
