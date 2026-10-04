// Safety net: known titles must always get a sensible label. Runs on every Cloudflare build (npm test);
// if a change breaks one of these, the build fails and the broken version is never deployed.
import test from 'node:test';
import assert from 'node:assert/strict';

const J = (o) => new Response(JSON.stringify(o));
const grid = (title, age, rows) =>
  `<title>${title} Review | Common Sense Media</title><h2>Why Age ${age}+?</h2>` +
  rows.map(([label, level, text]) => `<div><div>${label}</div>${level ? `<span>${level}</span>` : ''}<p>${text}</p></div>`).join('');

const TITLES = {
  tt1000001: { name: 'Toy Story 5', year: '2026', cert: 'PG', html: grid('Toy Story 5', 5, [
    ['Violence &amp; Scariness', 'a lot', 'A few sequences have peril. Frequent chases and intense moments, repeated falls, heavy machinery.'],
    ['Language', 'some', 'Mild language includes "shut up."'],
    ['Sex, Romance &amp; Nudity', 'some', ''],
  ]) },
  tt1000002: { name: 'The Mask', year: '1994', cert: 'PG-13', html: grid('The Mask', 12, [
    ['Violence &amp; Scariness', '', 'Lots of cartoonish violence.'],
    ['Language', 'some', 'Some profanity.'],
    ['Sex, Romance &amp; Nudity', '', "Cameron Diaz's cleavage is its own character."],
  ]) },
  tt1000003: { name: 'Grown Up Drama', year: '2024', cert: 'R', html: grid('Grown Up Drama', 17, [
    ['Violence &amp; Scariness', 'a lot', 'Constant graphic violence and killings.'],
    ['Language', 'a lot', 'Constant strong profanity.'],
    ['Sex, Romance &amp; Nudity', 'a lot', 'Explicit sex scenes with full nudity.'],
  ]) },
  tt1000004: { name: 'Nobody Knows This One', year: '2001', cert: null, html: null },
};

globalThis.fetch = async (url) => {
  url = String(url);
  const id = Object.keys(TITLES).find((k) => url.includes(k));
  if (url.includes('cinemeta') && url.includes('/meta/')) {
    const t = TITLES[url.match(/tt\d+/)?.[0]];
    return t ? J({ meta: { id: url.match(/tt\d+/)[0], name: t.name, year: t.year, description: 'd' } }) : new Response('nf', { status: 404 });
  }
  const m = url.match(/commonsensemedia\.org\/movie-reviews\/([a-z0-9-]+)$/);
  if (m) {
    const t = Object.values(TITLES).find((x) => x.name.toLowerCase().replace(/ /g, '-') === m[1]);
    return t?.html ? new Response(t.html) : new Response('nf', { status: 404 });
  }
  if (url.includes('/find/')) return J({ movie_results: [{ id: Number(url.match(/tt(\d+)/)[1]) }] });
  const rd = url.match(/movie\/(\d+)\/release_dates/);
  if (rd) {
    const t = TITLES['tt' + rd[1]];
    return J({ results: t?.cert ? [{ iso_3166_1: 'US', release_dates: [{ certification: t.cert }] }] : [] });
  }
  return new Response('nf', { status: 404 });
};

const worker = (await import('../src/index.js')).default;
const ctx = { waitUntil() {} };
const env = { TMDB_API_KEY: 'test' };
const get = (path) => worker.fetch(new Request('https://t.dev' + path), env, ctx);
const stream = async (id) => (await (await get(`/stream/movie/${id}.json`)).json()).streams?.[0];

test('kids film (age 5+) is SAFE even if the page has scary-sounding words', async () => {
  const s = await stream('tt1000001');
  assert.equal(s.safenest.label, 'SAFE');
  assert.match(s.name, /5\+/);
});

test('teen film (12+) is SLIGHTLY SAFE', async () => {
  const s = await stream('tt1000002');
  assert.equal(s.safenest.label, 'SLIGHTLY SAFE');
});

test('adult film (17+) is UNSAFE', async () => {
  const s = await stream('tt1000003');
  assert.equal(s.safenest.label, 'UNSAFE');
});

test('title with no data gets no card', async () => {
  assert.equal(await stream('tt1000004'), undefined);
});

test('card text is clean: no HTML leftovers, no "..", no cut-off dots', async () => {
  for (const id of ['tt1000001', 'tt1000002', 'tt1000003']) {
    const s = await stream(id);
    assert.doesNotMatch(s.description, /&lt;|&gt;|<|>|\.\.|…/);
  }
});

test('hidden label marker matches exactly its own regex', async () => {
  const R = await (await get('/labels.json')).json();
  for (const [id, label] of [['tt1000001', 'SAFE'], ['tt1000002', 'SLIGHTLY SAFE'], ['tt1000003', 'UNSAFE']]) {
    const s = await stream(id);
    for (const k of ['SAFE', 'SLIGHTLY SAFE', 'UNSAFE', 'NOT RATED']) {
      assert.equal(new RegExp(R[k]).test(s.name), k === label, `${id} vs ${k}`);
    }
  }
});

test('badge, card page and api answer for a rated title', async () => {
  assert.equal((await get('/badge/movie/tt1000001.svg')).status, 200);
  assert.equal((await get('/card/movie/tt1000001')).status, 200);
  assert.equal((await (await get('/api/movie/tt1000001.json')).json()).label, 'SAFE');
  assert.equal((await get('/regex')).status, 200);
});
