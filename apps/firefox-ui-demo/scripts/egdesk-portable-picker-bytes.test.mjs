import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createPortableFlow, portableSourceFromBytes } from '../overlay/resources/EGDeskPortableState.sys.mjs';

test('foreign-realm picker bytes reach inspect unchanged, not as a path or an import', async () => {
  const bytes = vm.runInNewContext('new Uint8Array([255, 80, 75, 3, 4, 1, 254]).subarray(1, 6)');
  const requests = [];
  const flow = createPortableFlow({ readFile: async () => ({ fileName: 'local.egdesk', bytes }), request: async (method, path, body) => {
    requests.push({ method, path, body });
    return { status: 200, body: { scope: 'board', boards: 1, cards: 2, chats: 0, title: 'Owned fixture' } };
  } });
  await flow.openImport({ exportsList: false });
  const view = await flow.chooseFile();
  assert.equal(view.step, 'preview');
  assert.equal(view.preview.fileName, 'local.egdesk');
  assert.equal(view.preview.replacesDesk, false);
  assert.deepEqual(requests, [{ method: 'POST', path: '/v1/portable/inspect', body: { bundle: 'UEsDBAE=' } }]);
});

test('still accepts ArrayBuffer and genuine Uint8Array only, across realms', () => {
  const buf = vm.runInNewContext('Uint8Array.from([1, 2, 3]).buffer');
  for (const good of [buf, new Uint8Array([1, 2, 3])]) assert.equal(portableSourceFromBytes('x.egdesk', good).bundle, 'AQID');
  for (const bad of [undefined, {}, { [Symbol.toStringTag]: 'Uint8Array', byteLength: 3, 0: 1 }, new Uint16Array(2), new Uint8ClampedArray(2), new DataView(new ArrayBuffer(2)), new SharedArrayBuffer(2), new Uint8Array(0)]) {
    assert.equal(portableSourceFromBytes('x.egdesk', bad), null);
  }
});
