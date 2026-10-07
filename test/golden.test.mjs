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
    ['Drinking, Drugs &amp; Smoking', 'a lot', 'Frequent cocaine use. Characters drink heavily throughout the film.'],
    ['Sex, Romance &amp; Nudity', 'a lot', 'Explicit sex scenes with full nudity. A long bedroom scene is shown in detail.'],
  ]) },
  tt1000004: { name: 'Nobody Knows This One', year: '2001', cert: null, html: null },
  // pages that used to leak questions, buttons and other categories into the cards
  tt1000005: { name: 'Wadjda', year: '2012', cert: 'PG', html: `<title>Wadjda Movie Review | Common Sense Media</title><h2>Why Age 9+?</h2>
    <div><div>Violence &amp; Scariness</div><p>Wadjda falls off her bike. Some sad moments.</p><h3>Any Positive Content?</h3><p>The movie encourages independence and equal rights for girls.</p><h4>Positive Messages</h4></div>
    <div><div>Language</div><span>very little</span><p>One use of "damn" (in subtitles).</p><p>Did you know you can flag iffy content?</p><p>Adjust limits for Language in your kid's entertainment guide.</p><button>Get started</button><button>Close</button></div>
    <div><div>Drinking, Drugs &amp; Smoking</div><p>Wadjda's mother smoke cigarettes more and more as the movie progresses.</p></div>
    <div><div>Sex, Romance &amp; Nudity</div><p>Wadjda's mother works hard to look her best for her husband and to please hi</p><p>Wadjda falls off her bike. Some sad moments.</p></div>
    <div><div>Products &amp; Purchases</div><p>Some car companies logos/ brands seen, like Chevy Suburban, Mercedes, etc.</p></div>` },
  tt1000006: { name: 'The Mask Reloaded', year: '1994', cert: 'PG-13', html: `<title>The Mask Reloaded Movie Review | Common Sense Media</title><h2>Why Age 12+?</h2>
    <div><div>Violence &amp; Scariness</div><p>Lots of cartoonish violence.</p></div>
    <div><div>Language</div><span>some</span><p>Some profanity.</p><p>Did you know you can flag iffy content?</p><p>Adjust limits for Language in your kid's entertainment guide.</p><button>Get started</button><button>Close</button></div>
    <div><div>Drinking, Drugs &amp; Smoking</div><p>Drinking.</p><p>Some profanity.</p></div>
    <div><div>Sex, Romance &amp; Nudity</div><p>Cameron Diaz <a>'s</a> cleavage is its own character. Sex jokes.</p><p>Lots of cartoonish violence.</p></div>
    <div><div>Products &amp; Purchases</div><span>Not present</span></div>` },
  // the dots' own numbers are stated in aria-labels; a star rating after the grid must never be mistaken for one
  tt1000007: { name: 'Dots Test', year: '2010', cert: 'PG-13', html: `<title>Dots Test Movie Review | Common Sense Media</title><h2>Why Age 13+?</h2>
    <div><div>Violence &amp; Scariness</div><span aria-label="Rating: 4 out of 5"></span><p>Several intense fight scenes with injuries.</p></div>
    <div><div>Language</div><span aria-label="Rating: 3 out of 5"></span><p>Some strong words.</p></div>
    <div><div>Drinking, Drugs &amp; Smoking</div><span aria-label="Rating: 2 out of 5"></span><p>Characters drink at a party.</p></div>
    <div><div>Sex, Romance &amp; Nudity</div><span aria-label="Rating: 1 out of 5"></span><p>A brief kiss.</p></div>
    <div aria-label="Our review: 5 out of 5 stars"></div>` },
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
  if (url.includes('/3/configuration')) return J({ images: {} });
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
const stream = async (id, style = '') => (await (await get(`${style}/stream/movie/${id}.json`)).json()).streams?.[0];

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

test('detailed style keeps every sentence and adds drinking & drugs', async () => {
  const s = await stream('tt1000003', '/detailed');
  assert.match(s.description, /Constant graphic violence and killings\./);
  assert.match(s.description, /Explicit sex scenes with full nudity\. A long bedroom scene is shown in detail\./);
  assert.match(s.description, /Frequent cocaine use\. Characters drink heavily throughout the film\./);
  assert.equal(s.safenest.label, 'UNSAFE');
});

test('minimal style shows only ratings as dots, no descriptions', async () => {
  const s = await stream('tt1000003', '/minimal');
  assert.match(s.description, /●●●●●/);
  assert.doesNotMatch(s.description, /Constant|Explicit|cocaine/);
  const mask = await stream('tt1000002', '/minimal');
  assert.match(mask.description, /[●○]{5}/);
  assert.doesNotMatch(mask.description, /cartoonish|profanity/);
});

test('each style has its own addon id and name', async () => {
  const ids = [];
  for (const prefix of ['', '/detailed', '/minimal']) ids.push((await (await get(`${prefix}/manifest.json`)).json()).id);
  assert.equal(new Set(ids).size, 3);
  assert.equal((await (await get('/detailed/manifest.json')).json()).name, 'SafeNest Detailed');
});

const getWith = (e, path, init) => worker.fetch(new Request('https://t.dev' + path, init), e, ctx);

test('Wadjda: no questions, buttons, other sections or product text in the detailed card', async () => {
  const s = await stream('tt1000005', '/detailed');
  assert.doesNotMatch(s.description, /Did you know|Adjust limits|Get started|Close|Any Positive|Positive Messages|logos|Chevy/);
  assert.match(s.description, /One use of "damn" \(in subtitles\)\./);
  assert.match(s.description, /Wadjda falls off her bike\. Some sad moments\./);
  assert.equal((s.description.match(/Wadjda falls off her bike\./g) || []).length, 1);
  assert.notEqual(s.safenest.label, 'UNSAFE');                 // 9+ with a few sad moments must never be unsafe
});

test('The Mask: every sentence appears only under its own category', async () => {
  const s = await stream('tt1000006', '/detailed');
  assert.equal((s.description.match(/Lots of cartoonish violence\./g) || []).length, 1);
  assert.equal((s.description.match(/Some profanity\./g) || []).length, 1);
  assert.doesNotMatch(s.description, /Did you know|Get started/);
  assert.match(s.description, /Cameron Diaz's cleavage is its own character\. Sex jokes\./);
  assert.equal(s.safenest.label, 'SLIGHTLY SAFE');
});

test('tapping the card opens the original source page, not our own page', async () => {
  const s = await stream('tt1000001');
  assert.equal(s.externalUrl, 'https://www.commonsensemedia.org/movie-reviews/toy-story-5');
  assert.match(s.safenest.card, /\/card\/movie\/tt1000001$/);
});

test('personal link: style and own TMDB key travel inside the token', async () => {
  const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const made = await (await getWith(env, '/api/config', { method: 'POST', body: JSON.stringify({ s: 'minimal', t: key, c: 'US,GB' }) })).json();
  assert.equal(made.style, 'minimal');
  assert.equal(made.keyValid, true);
  const mani = await (await getWith(env, made.path)).json();
  assert.equal(mani.id, 'community.safenest.minimal');
  const s = (await (await getWith(env, `/c/${made.token}/stream/movie/tt1000003.json`)).json()).streams[0];
  assert.match(s.description, /●●●●●/);                       // minimal style came from the token
  assert.doesNotMatch(s.description, /Constant|Explicit/);
});

test('with CONFIG_SECRET the token is encrypted and hides the key', async () => {
  const key = '00112233445566778899aabbccddeeff';
  const e2 = { ...env, CONFIG_SECRET: 'unit-test-secret' };
  const made = await (await getWith(e2, '/api/config', { method: 'POST', body: JSON.stringify({ s: 'detailed', t: key }) })).json();
  assert.equal(made.encrypted, true);
  assert.equal(made.token[0], 'e');
  const decodedGuess = Buffer.from(made.token.slice(1).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
  assert.ok(!decodedGuess.includes(key));
  assert.equal((await (await getWith(e2, made.path)).json()).id, 'community.safenest.detailed');
  const bad = await (await getWith(env, made.path)).json();     // wrong/missing secret: falls back to the default style
  assert.equal(bad.id, 'community.safenest.family');
});

test('bad keys and countries in a config are ignored', async () => {
  const made = await (await getWith(env, '/api/config', { method: 'POST', body: JSON.stringify({ s: 'evil', t: 'not-a-key', c: 'xx,<script>' }) })).json();
  const raw = JSON.parse(Buffer.from(made.token.slice(1).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.deepEqual(raw, {});
});

test('landing page preview uses the real renderer', async () => {
  for (const style of ['compact', 'detailed', 'minimal']) {
    const p = await (await get(`/api/preview/${style}.json`)).json();
    assert.match(p.name, /🟠/);                                 // orange = slightly safe
  }
});

test('dots: the page\'s own 0-5 numbers are used, star ratings are ignored', async () => {
  const s = await stream('tt1000007', '/detailed');
  const lines = s.description.split('\n');
  const dotsOf = (name) => (lines.find((l) => l.includes(name)) || '').match(/[●○]{5}/)?.[0];
  assert.equal(dotsOf('𝗩𝗶𝗼𝗹𝗲𝗻𝗰𝗲'), '●●●●○');
  assert.equal(dotsOf('𝗟𝗮𝗻𝗴𝘂𝗮𝗴𝗲'), '●●●○○');
  assert.equal(dotsOf('𝗗𝗿𝗶𝗻𝗸𝗶𝗻𝗴'), '●●○○○');
  assert.equal(dotsOf('𝗦𝗲𝘅'), '●○○○○');
});
