import test from 'node:test';
import assert from 'node:assert/strict';
import { captureImages, fetchImage } from '../extension/images.js';

test('a page with no image candidates keeps its text available for chat', async () => {
  const url = 'https://example.com/article';
  const tab = { id: 42, windowId: 3, url };
  const page = { title: 'Text only', url, text: 'A useful article.', scope: 'page' };
  const calls = [];
  const api = {
    tabs: {
      query: async () => [tab],
      captureVisibleTab: async () => { throw new Error('A screenshot is unnecessary without images'); }
    },
    scripting: { executeScript: async ({ func, args }) => {
      calls.push({ name: func.name, args });
      const result = func.name === 'collectImages'
        ? { url, items: [], candidates: 0, viewport: { width: 800, height: 600, x: 0, y: 0 } }
        : func.name === 'extractPage'
          ? { ...page, sourceUrl: url, imagePositions: [] }
          : url;
      return [{ documentId: 'doc-1', result }];
    } }
  };
  const result = await captureImages(api, tab, { url, documentId: 'doc-1' }, 'page', page);
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.page, page);
  assert.deepEqual(result.missingOrigins, []);
  assert.equal(result.omitted, 0);
  assert.ok(calls.some(call => call.name === 'extractPage' && call.args[2].length === 0));
});

test('external image permission is scoped to its host and no request is made without it', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Network must stay unused'); });
  let requested;
  const result = await fetchImage('https://cdn.example/image.png?private=123', { permissions: { contains: async args => { requested = args; return false; } } });
  assert.deepEqual(requested, { origins: ['https://cdn.example/*'] });
  assert.deepEqual(result, { missingOrigin: 'https://cdn.example/*' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('file, script and URL credentials cannot be used for image fetching', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Network must stay unused'); });
  for (const url of ['file:///private.png', 'javascript:alert(1)', 'https://user:secret@example.com/image.png']) assert.deepEqual(await fetchImage(url, {}), {});
  assert.equal(fetch.mock.callCount(), 0);
});

test('image requests omit cookies and reject non-image responses without retaining their bodies', async t => {
  let canceled = false, options;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    options = init;
    return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'content-type': 'text/html' } });
  });
  assert.deepEqual(await fetchImage('https://cdn.example/not-an-image', { permissions: { contains: async () => true } }), {});
  assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.headers, undefined); assert.ok(options.signal instanceof AbortSignal); assert.equal(canceled, true);
});

test('image response size is enforced on streamed bytes even without Content-Length', async t => {
  let canceled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(6_100_000)); },
    cancel() { canceled = true; }
  }), { headers: { 'content-type': 'image/png' } }));
  assert.deepEqual(await fetchImage('https://cdn.example/huge.png', { permissions: { contains: async () => true } }), {});
  assert.equal(canceled, true);
});

const imageData = label => 'data:image/jpeg;base64,' + Buffer.from(label).toString('base64');
const directImage = label => ({ label, dataUrl: imageData(label), target: { path: [label] } });
const missingImage = label => ({ label, url: `https://cdn.example/${label}.jpg`, target: { path: [label] } });
const cropImage = (label, x = 10) => ({ ...missingImage(label), rect: { x, y: 20, width: 100, height: 80 } });

function imageCaptureFixture(t, items, { verify = true, oversizedCrop = false, moveAfterCrop = false } = {}) {
  const url = 'https://example.com/article', tab = { id: 42, windowId: 3, url };
  const page = { title: 'Article', url, text: 'A useful article with images.', scope: 'page' };
  const state = { screenshots: 0, decodes: 0, bitmaps: 0, closed: 0, draws: [], verifications: [], targets: [], progress: [] };
  const mockGlobal = (key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  };
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Network must stay unused'); });
  t.after(() => assert.equal(network.mock.callCount(), 0));
  mockGlobal('Image', class {
    async decode() { state.decodes++; assert.equal(this.src, 'data:image/png;base64,c2NyZWVuc2hvdA=='); }
  });
  const bitmap = { width: 1600, height: 1200, close() { state.closed++; } };
  mockGlobal('createImageBitmap', async () => { state.bitmaps++; return bitmap; });
  mockGlobal('document', {
    createElement(name) {
      assert.equal(name, 'canvas');
      return {
        getContext(kind) { assert.equal(kind, '2d'); return { drawImage(...args) { assert.equal(args[0], bitmap); state.draws.push(args.slice(1)); } }; },
        toDataURL() { return oversizedCrop ? 'x'.repeat(650001) : imageData('cropped'); }
      };
    }
  });
  const api = {
    permissions: { contains: async () => false },
    tabs: {
      query: async () => [moveAfterCrop && state.draws.length ? { ...tab, id: 43 } : tab],
      captureVisibleTab: async (windowId, options) => {
        assert.equal(windowId, tab.windowId); assert.deepEqual(options, { format: 'png' });
        state.screenshots++; return 'data:image/png;base64,c2NyZWVuc2hvdA==';
      }
    },
    scripting: { executeScript: async ({ func, args }) => {
      let result = url;
      if (func.name === 'collectImages') result = { url, items: structuredClone(items), candidates: items.length, viewport: { width: 800, height: 600, x: 0, y: 0 } };
      if (func.name === 'verifyImageSnapshot') { state.verifications.push(args); result = verify; }
      if (func.name === 'extractPage') {
        state.targets = args[2];
        result = { ...page, sourceUrl: url, imagePositions: state.targets.map(target => ({ id: target.id, offset: target.id })) };
      }
      return [{ documentId: 'doc-1', result }];
    } }
  };
  return { state, capture: maxImages => captureImages(api, tab, { url, documentId: 'doc-1' }, 'page', page, maxImages, progress => state.progress.push(progress)) };
}

test('image adoption captures a later crop after unavailable candidates even when six original images loaded', async t => {
  const items = [missingImage('unavailable'), ...Array.from({ length: 5 }, (_, index) => directImage('direct-' + index)), cropImage('visible-crop'), directImage('later-direct')];
  const { capture, state } = imageCaptureFixture(t, items);
  const result = await capture(6);
  assert.deepEqual(state.progress.at(-1), { processed: 8, candidates: 8, loaded: 6 });
  assert.deepEqual(result.images.map(image => image.label), [...items.slice(1, 6).map(image => image.label), 'visible-crop（画面に表示された範囲）']);
  assert.deepEqual(result.images.map(image => image.position), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(state.targets.map(target => target.path), items.slice(1, 7).map(image => image.target.path));
  assert.equal(state.screenshots, 1); assert.equal(state.closed, 1);
  assert.equal(result.omitted, 2);
});

test('images after the adopted limit do not trigger screenshot capture or decoding', async t => {
  const items = [...Array.from({ length: 6 }, (_, index) => directImage('direct-' + index)), cropImage('unused-crop')];
  const { capture, state } = imageCaptureFixture(t, items);
  const result = await capture(6);
  assert.deepEqual(result.images.map(image => image.label), items.slice(0, 6).map(image => image.label));
  assert.equal(state.screenshots, 0); assert.equal(state.decodes, 0); assert.equal(state.bitmaps, 0);
  assert.equal(state.verifications.length, 0); assert.equal(state.closed, 0);
});

test('multiple screenshot crops share one verified bitmap and release it after adoption', async t => {
  const items = [cropImage('first', 10), directImage('middle'), cropImage('last', 150)];
  const { capture, state } = imageCaptureFixture(t, items);
  const result = await capture(3);
  assert.deepEqual(result.images.map(image => image.label), ['first（画面に表示された範囲）', 'middle', 'last（画面に表示された範囲）']);
  assert.equal(state.screenshots, 1); assert.equal(state.decodes, 1); assert.equal(state.bitmaps, 1); assert.equal(state.closed, 1);
  assert.equal(state.verifications.length, 1);
  assert.deepEqual(state.verifications[0][1], [items[0], items[2]].map(item => ({ rect: item.rect, target: item.target })));
  assert.deepEqual(state.draws.map(args => args.slice(0, 4)), [[20, 40, 200, 160], [300, 40, 200, 160]]);
});

test('an oversized crop is skipped so a later original image can fill the remaining slot', async t => {
  const items = [directImage('first'), cropImage('too-large'), directImage('last')];
  const { capture, state } = imageCaptureFixture(t, items, { oversizedCrop: true });
  const result = await capture(2);
  assert.deepEqual(result.images.map(image => image.label), ['first', 'last']);
  assert.deepEqual(state.targets.map(target => target.path), [items[0].target.path, items[2].target.path]);
  assert.equal(state.screenshots, 1); assert.equal(state.closed, 1); assert.equal(result.omitted, 1);
});

test('moving screenshot targets reject capture before any pixels are cropped', async t => {
  const { capture, state } = imageCaptureFixture(t, [cropImage('moved')], { verify: false });
  await assert.rejects(capture(1), /画像の位置が変わりました/);
  assert.equal(state.screenshots, 1); assert.equal(state.verifications.length, 1);
  assert.equal(state.bitmaps, 0); assert.equal(state.draws.length, 0); assert.equal(state.targets.length, 0);
});

test('navigation detected after cropping rejects the snapshot and closes its bitmap', async t => {
  const { capture, state } = imageCaptureFixture(t, [cropImage('old-page')], { moveAfterCrop: true });
  await assert.rejects(capture(1), /ページが変わりました/);
  assert.equal(state.bitmaps, 1); assert.equal(state.closed, 1); assert.equal(state.targets.length, 0);
});
