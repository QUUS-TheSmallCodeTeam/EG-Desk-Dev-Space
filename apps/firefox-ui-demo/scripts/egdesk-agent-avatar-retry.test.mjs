import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AVATAR_RETRY_DELAYS_MS, createAvatarImageCache } from '../overlay/resources/EGDeskAgentIdentityView.sys.mjs';

const ASSET = `img-${'a'.repeat(64)}`;
const OTHER = `img-${'b'.repeat(64)}`;
const PNG = Buffer.alloc(1200, 1).toString('base64');
const photo = assetId => ({ assetId, mediaType: 'image/png', imageBase64: PNG });
const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

function harness(answers) {
  const loads = [];
  const timers = [];
  let changes = 0;
  const cache = createAvatarImageCache({
    load: (assetId) => {
      loads.push(assetId);
      const answer = answers.shift();
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    onChange: () => { changes += 1; },
    setTimer: (run, delay) => { timers.push({ run, delay }); },
  });
  return { cache, loads, timers, changes: () => changes };
}

test('B08: a photo that could not be read is asked for again after a wait, and shows once it arrives', async () => {
  const h = harness([new Error('bridge not ready'), photo(ASSET)]);
  assert.equal(h.cache.get(ASSET), null, 'the letter face stands in while the photo is read');
  assert.equal(h.cache.get(ASSET), null);
  await settle();
  assert.equal(h.loads.length, 1, 'drawing the face again does not ask twice');
  assert.deepEqual(h.timers.map(timer => timer.delay), [AVATAR_RETRY_DELAYS_MS[0]]);
  assert.equal(h.changes(), 0, 'a failed read redraws nothing');
  h.timers[0].run();
  await settle();
  assert.equal(h.loads.length, 2);
  assert.equal(h.cache.get(ASSET), `data:image/png;base64,${PNG}`);
  assert.equal(h.changes(), 1, 'the screen is redrawn when the photo arrives');
  assert.equal(h.timers.length, 1, 'nothing more is scheduled after the photo arrived');
});

test('B08: at most three more tries with growing waits, then the letter face stays', async () => {
  const h = harness([new Error('1'), new Error('2'), { assetId: OTHER, mediaType: 'image/png', imageBase64: PNG }, new Error('4'), photo(ASSET)]);
  h.cache.get(ASSET);
  await settle();
  for (let i = 0; i < AVATAR_RETRY_DELAYS_MS.length; i += 1) {
    assert.equal(h.timers.length, i + 1);
    h.timers[i].run();
    await settle();
  }
  assert.deepEqual(h.timers.map(timer => timer.delay), [...AVATAR_RETRY_DELAYS_MS]);
  assert.equal(AVATAR_RETRY_DELAYS_MS.length, 3);
  assert.ok(AVATAR_RETRY_DELAYS_MS.every((delay, index, list) => index === 0 || delay > list[index - 1]), 'each wait is longer than the last');
  assert.equal(h.loads.length, 4, 'one read and three more tries');
  assert.equal(h.cache.get(ASSET), null);
  await settle();
  assert.equal(h.loads.length, 4, 'after the last try it is not asked again');
  assert.equal(h.changes(), 0);
});

test('B08: each photo keeps its own tries; a name that is not a photo id is never read', async () => {
  const h = harness([new Error('first'), photo(OTHER)]);
  assert.equal(h.cache.get('img-short'), null);
  assert.equal(h.cache.get(null), null);
  h.cache.get(ASSET);
  h.cache.get(OTHER);
  await settle();
  assert.deepEqual(h.loads, [ASSET, OTHER]);
  assert.equal(h.cache.get(OTHER), `data:image/png;base64,${PNG}`);
  assert.equal(h.timers.length, 1, 'only the photo that failed waits for another try');
});

test('B08: the surface reads Agent photos through the retrying cache', () => {
  const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
  const start = source.indexOf('const avatarImages = AgentIdentityView.createAvatarImageCache({');
  assert.notEqual(start, -1, 'the bridge builds its photo cache from createAvatarImageCache');
  const block = source.slice(start, source.indexOf('const loadProfileCatalog', start));
  assert.match(block, /load: \(assetId\) => fetchJson\(`\/profiles\/avatar-images\/\$\{encodeURIComponent\(assetId\)\}`\)/);
  assert.match(block, /onChange: \(\) => emit\(\)/);
  assert.match(block, /setTimer: \(run, delay\) => window\.setTimeout\(run, delay\)/, 'the wait runs on the window timer');
  assert.match(block, /const avatarImage = \(assetId\) => avatarImages\.get\(assetId\);/);
  assert.doesNotMatch(block, /\.catch\(\(\) => \{\}\)/, 'a failed read is no longer swallowed for the whole session');
});
