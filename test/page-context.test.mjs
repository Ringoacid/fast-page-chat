import test from 'node:test';
import assert from 'node:assert/strict';
import { pageWithImageMarkers } from '../extension/page-context.js';
import { apiInput, codexInput, validateRequest } from '../server/prompt.mjs';

const page = { title: 'Article', url: 'https://example.com', text: 'First paragraph.\n\nSecond paragraph.' };
const image = position => ({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', label: 'Chart', ...(position !== undefined ? { position } : {}) });
test('markers preserve attachment identity even when positions are out of order or shared', () => {
  const result = pageWithImageMarkers(page, [image(page.text.length), image(16), image(16)]);
  assert.match(result.text, /First paragraph\.\n\n\[画像2\]\n\n\n\n\[画像3\]/);
  assert.ok(result.text.indexOf('[画像3]') < result.text.indexOf('Second paragraph.'));
  assert.ok(result.text.indexOf('Second paragraph.') < result.text.indexOf('[画像1]'));
  assert.equal(page.text, 'First paragraph.\n\nSecond paragraph.');
});
test('turning images off restores exact text and legacy images have unknown positions', () => {
  assert.deepEqual(pageWithImageMarkers(page, []), page);
  const result = pageWithImageMarkers(page, [image(), image(0)]);
  assert.ok(!result.text.includes('[画像1]')); assert.ok(result.text.startsWith('\n\n[画像2]'));
  assert.deepEqual(result.imageLocations, [{ id: 1, positionKnown: false }, { id: 2, positionKnown: true }]);
});
test('both providers pair the same markers with actual native image inputs', () => {
  const request = validateRequest({ provider: 'api', page, question: 'Explain the chart', images: [image(16), image()] });
  const api = apiInput(request), codex = codexInput(request);
  const apiPage = JSON.parse(api[0].content[0].text.split('\n').slice(1).join('\n'));
  const codexPage = JSON.parse(JSON.parse(codex[0].text)[0].content.split('\n').slice(1).join('\n'));
  assert.deepEqual(apiPage, codexPage);
  assert.match(apiPage.text, /First paragraph\.[\s]*\[画像1\][\s]*Second paragraph\./);
  assert.equal(api[0].content[2].type, 'input_image'); assert.equal(codex[2].type, 'image');
  assert.match(api[0].content[1].text, /画像1/); assert.match(codex[1].text, /画像1/);
  assert.equal(apiPage.imageLocations[1].positionKnown, false);
});
test('invalid offsets are rejected instead of associating an image with arbitrary text', () => {
  for (const position of [-1, 1.5, page.text.length + 1, '2']) assert.throws(() => validateRequest({ provider: 'api', page, question: 'test', images: [image(position)] }), /位置/);
});
