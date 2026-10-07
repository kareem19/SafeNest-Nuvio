// SafeNest: family-safety addon for Nuvio/Stremio on Cloudflare Workers.
// Primary source: Common Sense Media (age + Violence / Sex / Language / Drinking-Drugs grid).
// Fallbacks when it has nothing: isitsafe.tv, Kids-In-Mind, IMDb parents guide. TMDB gives country age ratings.
// Speed: answers within ~2.5s with whatever sources replied; slower sources finish in the
// background and are saved to the cache, so the next open is instant.
// Cache: memory -> KV (needs the "CACHE" KV binding; the Cache API is a no-op on workers.dev).

import { parseDetail } from './parse.js';
import { parseKim, slugify } from './kim.js';
import { parseImdbGuide, parseCsm } from './extra.js';

const SITE = 'https://isitsafe.tv';
const KIM = 'https://kids-in-mind.com';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const UA = 'isitsafe-nuvio-addon (personal project)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ICON = { SAFE: '🟢', 'SLIGHTLY SAFE': '🟠', UNSAFE: '🔴' };
const RANK = { SAFE: 0, 'SLIGHTLY SAFE': 1, UNSAFE: 2 };
const FRESH_FOUND = 7 * 86400e3;
const FRESH_MISSING = 6 * 3600e3;
const BUDGET_MS = Number(2500);   // max wait before answering with partial data
const FETCH_TIMEOUT_MS = 5000;
const KEY = 'v12';
const NAME = 'SafeNest'; // addon name shown in Nuvio (change here)

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MANIFEST = {
  id: 'community.safenest.family',
  version: '8.1.0',
  name: NAME,
  description: 'Family safety guide: Violence, Sex, Language and Drinking/Smoking explained, with an overall Safe / Slightly Safe / Unsafe label.',
  resources: ['stream', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

// ---------- fetching ----------
async function fetchText(url, tried, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    tried?.push({ url, status: res.status });
    return res.ok ? await res.text() : null;
  } catch (e) {
    tried?.push({ url, error: String(e) });
    return null;
  }
}
async function getJson(url, cacheSeconds) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ...(cacheSeconds ? { cf: { cacheTtl: cacheSeconds, cacheEverything: true } } : {}),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
const getCinemeta = async (type, imdb) => (await getJson(`${CINEMETA}/meta/${type}/${imdb}.json`, 86400))?.meta || null;
const yearOf = (meta) => Number(((meta.year || meta.releaseInfo || '') + '').match(/\d{4}/)?.[0]) || null;
const browser = { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9' };

async function findSite(type, meta, tried) {
  const base = slugify(meta.name || '');
  const y = yearOf(meta);
  if (!base) return null;
  const tryOne = async (slug) => {
    const html = await fetchText(`${SITE}/movie/${slug}`, tried);
    return html && parseDetail(html, slug);
  };
  if (type === 'series') return tryOne(`${base}-tv`);
  if (!y) return null;
  const first = await tryOne(`${base}-${y}`);
  if (first) return first;
  const rest = await Promise.all([tryOne(`${base}-${y - 1}`), tryOne(`${base}-${y + 1}`)]);
  return rest.find(Boolean) || null;
}

async function findKim(meta, tried) {
  const y = yearOf(meta);
  if (!meta.name || !y) return null;
  const flat = meta.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!flat) return null;
  const direct = [`${KIM}/${flat[0]}/${flat}.htm`, `${KIM}/${flat[0]}/${flat}${String(y).slice(2)}.htm`];
  const [search, ...pages] = await Promise.all([
    fetchText(`${KIM}/?s=${encodeURIComponent(meta.name)}`, tried, browser),
    ...direct.map((u) => fetchText(u, tried, browser)),
  ]);
  for (let i = 0; i < pages.length; i++) {
    const rec = pages[i] && parseKim(pages[i], meta.name, y, direct[i]);
    if (rec) return rec;
  }
  if (!search) return null;
  const found = [...search.matchAll(/href="(https?:\/\/(?:www\.)?kids-in-mind\.com\/(?:[a-z0-9]\/[a-z0-9_-]+\.htm|\?p=\d+))"/gi)]
    .map((m) => m[1])
    .filter((u) => !direct.includes(u))
    .slice(0, 3);
  const more = await Promise.all(found.map((u) => fetchText(u, tried, browser)));
  for (let i = 0; i < more.length; i++) {
    const rec = more[i] && parseKim(more[i], meta.name, y, found[i]);
    if (rec) return rec;
  }
  return null;
}

async function findImdb(imdb, tried) {
  const html = await fetchText(`https://www.imdb.com/title/${imdb}/parentalguide/`, tried, browser);
  return html ? parseImdbGuide(html) : null;
}

async function findCsm(type, meta, tried) {
  const slug = slugify(meta.name || '');
  if (!slug) return null;
  const y = yearOf(meta);
  const kind = type === 'series' ? 'tv' : 'movie';
  const slugs = type === 'movie' && y ? [slug, `${slug}-${y}`] : [slug];
  const results = await Promise.all(
    slugs.map(async (sl) => {
      const url = `https://www.commonsensemedia.org/${kind}-reviews/${sl}`;
      const html = await fetchText(url, tried, browser);
      if (!html) return null;
      const rec = parseCsm(html, meta.name, url, !!tried);
      if (tried) tried.push({ url, parsed: !!rec, gridRegionText: rec?._region || null });   // debug only
      if (rec) delete rec._region;
      return rec;
    }),
  );
  return results.find(Boolean) || null;
}

// Age ratings for several countries (TMDB). Needs TMDB_API_KEY; AGE_COUNTRIES optional, e.g. "US,GB,DE"
async function findCerts(type, imdb, env) {
  const key = env?.TMDB_API_KEY;
  if (!key) return [];
  const countries = (env.AGE_COUNTRIES || 'US,GB,DE').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const f = await getJson(`https://api.themoviedb.org/3/find/${imdb}?api_key=${key}&external_source=imdb_id`);
  const hit = type === 'series' ? f?.tv_results?.[0] : f?.movie_results?.[0];
  if (!hit) return [];
  const out = [];
  if (type === 'series') {
    const r = await getJson(`https://api.themoviedb.org/3/tv/${hit.id}/content_ratings?api_key=${key}`);
    for (const c of countries) {
      const v = r?.results?.find((x) => x.iso_3166_1 === c)?.rating;
      if (v) out.push({ c, r: v });
    }
  } else {
    const r = await getJson(`https://api.themoviedb.org/3/movie/${hit.id}/release_dates?api_key=${key}`);
    for (const c of countries) {
      const v = r?.results?.find((x) => x.iso_3166_1 === c)?.release_dates?.map((d) => d.certification).find(Boolean);
      if (v) out.push({ c, r: v });
    }
  }
  return out;
}

// Common Sense Media first (+ age ratings). isitsafe.tv / Kids-In-Mind / IMDb only run if Common Sense
// has no content grid for the title. `data` fills in as sources finish; `done` resolves when all have.
const GRID_KEYS = ['violence', 'sex', 'language'];
function collect(type, imdb, meta, env, tried) {
  const data = { csm: null, site: null, kim: null, imdb: null, certs: [], brief: null };
  const run = (p, set) => p.then(set).catch(() => {});
  const csmP = run(findCsm(type, meta, tried?.csm), (v) => (data.csm = v));
  const fallbackP = csmP.then(() =>
    GRID_KEYS.some((k) => data.csm?.[k])
      ? null
      : Promise.all([
          run(findSite(type, meta, tried?.site), (v) => (data.site = v)),
          type === 'movie' ? run(findKim(meta, tried?.kim), (v) => (data.kim = v)) : null,
          run(findImdb(imdb, tried?.imdb), (v) => (data.imdb = v)),
        ]),
  ).catch(() => {});
  // short one-line reasons written by Workers AI (needs the AI binding); cached with the rest
  const briefP = fallbackP
    .then(() => briefWithAI(env, data))
    .then((v) => { if (v) data.brief = v; })
    .catch(() => {});
  return { data, done: Promise.all([csmP, fallbackP, briefP]) };
}

// Country age ratings are only a fallback (no Common Sense age) and depend on the user's own TMDB key / countries,
// so they are fetched per request and never stored in the shared cache.
async function withCerts(r, type, imdb, env) {
  if (!r || r.data.csm?.age || !env?.TMDB_API_KEY) return r;
  const certs = await findCerts(type, imdb, env);
  return certs.length ? { ...r, data: { ...r.data, certs } } : r;
}

// ---------- cache: memory -> KV ----------
const mem = new Map();
const inflight = new Map();

async function readStore(key, env) {
  if (mem.has(key)) return mem.get(key);
  let rec = null;
  try {
    if (env?.CACHE) rec = await env.CACHE.get(key, { type: 'json', cacheTtl: 600 });
  } catch {}
  if (rec) {
    if (mem.size > 500) mem.clear();
    mem.set(key, rec);
  }
  return rec;
}

async function writeStore(key, rec, env) {
  if (mem.size > 500) mem.clear();
  mem.set(key, rec);
  try {
    if (env?.CACHE) await env.CACHE.put(key, JSON.stringify(rec), { expirationTtl: 30 * 86400 });
  } catch {} // e.g. free-plan daily write limit reached: memory cache still works
}

const isAny = (d) => !!(d.site || d.kim || d.imdb || d.csm || d.certs?.length);
const isFresh = (rec) => Date.now() - rec.at < (isAny(rec.data) ? FRESH_FOUND : FRESH_MISSING);
const keyOf = (type, imdb) => `${KEY}/${type}/${imdb}`;

// Fetch everything for a title and save it (used for stale refresh and pre-warming).
async function refresh(type, imdb, env, meta) {
  const key = keyOf(type, imdb);
  meta = meta || (await getCinemeta(type, imdb));
  if (!meta) return null;
  const { data, done } = collect(type, imdb, meta, env);
  await done;
  await writeStore(key, { data, at: Date.now() }, env);
  return data;
}

// Returns { data, partial }. Cached -> instant. Otherwise waits at most BUDGET_MS.
async function lookup(type, imdb, ctx, env, meta) {
  const key = keyOf(type, imdb);
  const rec = await readStore(key, env);
  if (rec) {
    if (!isFresh(rec) && ctx?.waitUntil) ctx.waitUntil(refresh(type, imdb, env, meta)); // serve stale, refresh later
    return { data: rec.data, partial: false };
  }

  let job = inflight.get(key);
  if (!job) {
    meta = meta || (await getCinemeta(type, imdb));
    if (!meta) return null;
    const { data, done } = collect(type, imdb, meta, env);
    const finish = done.then(async () => {
      await writeStore(key, { data: { ...data }, at: Date.now() }, env);
      inflight.delete(key);
    });
    job = { data, done, finish };
    inflight.set(key, job);
    if (ctx?.waitUntil) ctx.waitUntil(finish);
  }
  const state = await Promise.race([job.done.then(() => 'done'), sleep(BUDGET_MS).then(() => 'timeout')]);
  if (state === 'done' && !ctx?.waitUntil) await job.finish;
  return { data: { ...job.data }, partial: state === 'timeout' };
}

// Cron: pre-warm popular titles, 1 per run (needs the KV binding).
async function prewarm(env) {
  let list = await env.CACHE.get('popular:v1', 'json');
  if (!list || Date.now() - list.at > 86400e3) {
    const items = [];
    for (const [type, skips] of [['movie', [0, 100, 200]], ['series', [0, 100]]]) {
      for (const s of skips) {
        const r = await getJson(`${CINEMETA}/catalog/${type}/top${s ? `/skip=${s}` : ''}.json`);
        for (const m of r?.metas || []) if (/^tt\d+$/.test(m.id)) items.push({ type, id: m.id });
      }
    }
    if (items.length) await env.CACHE.put('popular:v1', JSON.stringify({ items, at: Date.now() }));
    return;
  }
  const L = list.items.length;
  const base = Math.floor(Date.now() / 120000); // every 2 minutes
  for (let i = 0; i < L; i++) { // first title that still needs data
    const it = list.items[(base + i) % L];
    const rec = await env.CACHE.get(keyOf(it.type, it.id), 'json');
    if (rec && isFresh(rec)) continue;
    await refresh(it.type, it.id, env);
    return;
  }
}

// ---------- AI: one short, complete line per category ----------
function parseBrief(txt) {
  const m = String(txt || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (!CATS.some((c) => c.id === k) || typeof v !== 'string') continue;
      let t = v.trim().replace(/["“”]/g, '');
      if (!t || t.length > 60 || /…|\.\.\./.test(t)) continue; // too long or cut off: ignore, fallback is used
      if (!/[.!?]$/.test(t)) t += '.';
      out[k] = t;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

async function briefWithAI(env, d) {
  if (!env?.AI) return null;
  const items = {};
  for (const { id } of CATS) {
    const x = facet(id, d);
    if (x?.text && (x.sev == null || x.sev >= 2)) items[id] = x.text.slice(0, 350);
  }
  if (!Object.keys(items).length) return null;
  try {
    const run = env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      max_tokens: 220,
      messages: [
        {
          role: 'system',
          content:
            'You write ultra-short parental-guide notes. For each key in the JSON the user sends, rewrite the text as ONE complete sentence of at most 8 words, in plain words, keeping the single most important fact. No quotes, no ellipsis, no profanity spelled out. Reply with only a JSON object using the same keys.',
        },
        { role: 'user', content: JSON.stringify(items) },
      ],
    });
    const r = await Promise.race([run, sleep(8000).then(() => null)]);
    const text = typeof r?.response === 'string' ? r.response : r?.response ? JSON.stringify(r.response) : '';
    return parseBrief(text);
  } catch {
    return null;
  }
}

// ---------- hidden label markers (invisible text, so a badge can be attached to each card later) ----------
// Format: WORD-JOINER + two zero-width chars + WORD-JOINER.  ZWSP = U+200B ("0"), ZWNJ = U+200C ("1")
const WJ = '\u2060';
const Z0 = '\u200B';
const Z1 = '\u200C';
const MARK = {
  SAFE: `${WJ}${Z0}${Z0}${WJ}`,
  'SLIGHTLY SAFE': `${WJ}${Z0}${Z1}${WJ}`,
  UNSAFE: `${WJ}${Z1}${Z0}${WJ}`,
  'NOT RATED': `${WJ}${Z1}${Z1}${WJ}`,
};
const MARK_REGEX = {
  SAFE: '\\u2060\\u200B\\u200B\\u2060',
  'SLIGHTLY SAFE': '\\u2060\\u200B\\u200C\\u2060',
  UNSAFE: '\\u2060\\u200C\\u200B\\u2060',
  'NOT RATED': '\\u2060\\u200C\\u200C\\u2060',
  ANY: '\\u2060[\\u200B\\u200C]{2}\\u2060',
};

// ---------- label + card ----------
const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const bold = (s) =>
  [...s]
    .map((c) => {
      if (c >= 'A' && c <= 'Z') return String.fromCodePoint(0x1d5d4 + c.charCodeAt(0) - 65);
      if (c >= 'a' && c <= 'z') return String.fromCodePoint(0x1d5ee + c.charCodeAt(0) - 97);
      if (c >= '0' && c <= '9') return String.fromCodePoint(0x1d7ec + c.charCodeAt(0) - 48);
      return c;
    })
    .join('');
const dots = (n) => '●'.repeat(Math.max(0, Math.min(5, n))) + '○'.repeat(5 - Math.max(0, Math.min(5, n)));

// Complete, brief text: whole sentences only, no mid-sentence cut-offs.
const shorten = (r, max = 110) => {
  r = r.trim().replace(/\s+/g, ' ');
  if (r.length <= max) return r;
  const sentence = r.match(/^.*?[.!?](?=\s|$)/)?.[0];
  if (sentence && sentence.length <= max) return sentence;
  const cut = r.slice(0, max);
  const i = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' - '));
  return i >= 40 ? cut.slice(0, i) : r;
};
// One short line (about 50 characters): first sentence, else its first clause, else cut at a word.
function oneLine(text, max = 52) {
  let t = (text || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^parents need to know that\s+/i, '');
  const sentence = (t.match(/^.*?[.!?](?=\s|$)/)?.[0] || t).replace(/[.\s]+$/, '');
  if (sentence.length <= max) return sentence ? `${sentence}.` : '';
  const clause = sentence.split(/,|;| — | - | but | and /)[0].trim();
  if (clause.length >= 12 && clause.length <= max) return `${clause}.`;
  return sentence.slice(0, max).replace(/\s+\S*$/, '') + '…';
}
const closed = (t) => (/[.!?"')]$/.test(t) ? t : `${t}…`);
const WEIGHTS = [
  [/explicit|graphic|full[- ]frontal|sex scene|intercourse|masturbat|orgy|porn|rape/i, 4],
  [/nudity|nude|topless|breast|naked|genital|buttock|rear|bare/i, 3],
  [/sexual|sex |kiss|cleavage|lingerie|innuendo|underwear/i, 2],
];
const weigh = (r) => WEIGHTS.find(([re]) => re.test(r))?.[1] ?? 1;
function briefReasons(reasons, max = 120) {
  const ranked = reasons
    .map((r, i) => ({ r: r.trim().replace(/[.\s]+$/, ''), i }))
    .filter((x) => x.r)
    .map((x) => ({ ...x, w: weigh(x.r) }))
    .sort((a, b) => b.w - a.w || a.i - b.i);
  const picked = [];
  let len = 0;
  for (const x of ranked) {
    const t = shorten(x.r);
    const add = (picked.length ? 3 : 0) + t.length;
    if (picked.length && len + add > max) continue;
    picked.push({ t, i: x.i });
    len += add;
  }
  return picked.sort((a, b) => a.i - b.i).map((p) => p.t).join(' · ');
}

// Age ratings -> rough rating (only used when there is no content information at all)
const AGE_WORDS = {
  G: 'SAFE', PG: 'SAFE', U: 'SAFE', 'TV-Y': 'SAFE', 'TV-Y7': 'SAFE', 'TV-Y7-FV': 'SAFE', 'TV-G': 'SAFE', 'TV-PG': 'SAFE',
  'PG-13': 'SLIGHTLY SAFE', 'TV-14': 'SLIGHTLY SAFE',
  R: 'UNSAFE', 'TV-MA': 'UNSAFE', 'NC-17': 'UNSAFE', X: 'UNSAFE',
};
const byAge = (n) => (n <= 11 ? 'SAFE' : n <= 14 ? 'SLIGHTLY SAFE' : 'UNSAFE');
function certRating(r) {
  const k = String(r).toUpperCase().trim();
  if (AGE_WORDS[k]) return AGE_WORDS[k];
  const n = parseInt(k.replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(n) ? null : byAge(n);
}
function ageOnly(d) {
  const votes = [...(d.certs || []).map((x) => certRating(x.r)), d.csm?.age ? byAge(d.csm.age) : null].filter(Boolean);
  if (!votes.length) return null;
  const counts = {};
  for (const r of votes) counts[r] = (counts[r] || 0) + 1;
  return Object.keys(counts).sort((x, y) => counts[y] - counts[x] || RANK[y] - RANK[x])[0];
}

// Severity 0-5 guessed from a description when the score is missing
function textSeverity(text) {
  const t = (text || '').toLowerCase();
  if (!t) return null;
  if (/constant|non-?stop|graphic|gory|brutal|explicit|pervasive|extreme|rape|torture|bloody|strong language|f-word|f--k|motherf|frequent|repeated|heavy|intense|sex scene/.test(t)) return 4;
  if (/\b(no|not|without|none)\b[^.]{0,40}\b(nudity|sex|violence|language|profanity)\b/.test(t)) return 1;
  if (/lots of|a lot of/.test(t)) return 3;
  if (/mild|brief|infrequent|occasional|cartoon|slapstick|kiss|innuendo|cleavage|some |a little|a few|few |minor|implied|suggestive|peril|scary|spooky/.test(t)) return 2;
  return 3;
}
// Common Sense intensity words -> 0-5
const LEVEL_SEV = { 'not present': 0, none: 0, 'very little': 1, 'a little': 1, little: 1, some: 3, 'quite a bit': 4, 'a lot': 5, lots: 5 };
// CSM age caps how severe a category can plausibly be (guards against a mis-read number)
// a number the page states explicitly is trusted much more than a guess; only blatant mismatches are capped
const capScore = (n, age) => (age ? Math.min(n, age <= 7 ? 2 : age <= 9 ? 3 : age <= 12 ? 4 : 5) : n);
const capByAge = (n, age) => (age ? Math.min(n, age <= 7 ? 1 : age <= 9 ? 2 : age <= 13 ? 3 : age <= 15 ? 4 : 5) : n);
const sevOfSite = (r) => ({ SAFE: 0, 'SLIGHTLY SAFE': 2, UNSAFE: 4 })[r] ?? null;
const sevOfImdb = (s) => ({ None: 0, Mild: 2, Moderate: 3, Severe: 5 })[s] ?? null;

const CATS = [
  { id: 'violence', label: 'Violence & Scariness' },
  { id: 'sex', label: 'Sex, Romance & Nudity' },
  { id: 'language', label: 'Language' },
];

// One category: Common Sense first, then isitsafe.tv / Kids-In-Mind / IMDb as fallbacks
function facet(id, d, full = false) {
  const c = [];
  const cs = d.csm?.[id];
  if (cs) {
    // the dots' own number if the page states it, else the intensity word, else keywords in the description
    const sev = cs.score != null ? capScore(cs.score, d.csm?.age) : LEVEL_SEV[cs.level] ?? (cs.text ? textSeverity(cs.text) : null);
    c.push({ sev, text: cs.text || '', explicit: cs.score != null });
  }
  if (id === 'sex') {
    if (d.site) {
      const reasons = d.site.reasons?.length ? d.site.reasons : [d.site.summary].filter(Boolean);
      c.push({ sev: sevOfSite(d.site.rating), text: reasons.length ? (full ? reasons.map((r) => r.replace(/[.\s]+$/, '') + '.').join(' ') : `${briefReasons(reasons)}.`) : '' });
    }
    if (d.kim) c.push({ sev: Math.round(d.kim.sex / 2), text: d.kim.snippet || '' });
    if (d.imdb?.nudity) c.push({ sev: sevOfImdb(d.imdb.nudity), text: '' });
  } else if (id === 'violence') {
    if (d.kim) c.push({ sev: Math.round(d.kim.violence / 2), text: '' });
    if (d.imdb?.violence) c.push({ sev: sevOfImdb(d.imdb.violence), text: '' });
  } else if (id === 'language') {
    if (d.kim) c.push({ sev: Math.round(d.kim.language / 2), text: '' });
    if (d.imdb?.profanity) c.push({ sev: sevOfImdb(d.imdb.profanity), text: '' });
  } else if (id === 'drugs') {
    if (d.imdb?.alcohol) c.push({ sev: sevOfImdb(d.imdb.alcohol), text: '' });
  }
  const pick = c.find((x) => x.sev != null);
  const sev = pick ? (pick.explicit ? pick.sev : capByAge(pick.sev, d.csm?.age)) : null; // guesses are capped by age, stated numbers are not
  const text = c.find((x) => x.text)?.text || '';
  return sev == null && !text ? null : { sev, text };
}

// Fallback when there is no AI line: a complete short phrase, never cut off with "…"
const GENERIC = {
  violence: ['', 'Mild peril', 'Some mild violence', 'Moderate violence', 'Strong violence', 'Intense violence'],
  sex: ['', 'Kissing only', 'Romance and innuendo', 'Sexual content', 'Strong sexual content', 'Explicit sex and nudity'],
  language: ['', 'Mild words', 'Some strong words', 'Frequent strong words', 'Strong profanity', 'Constant profanity'],
};
function shortLine(x, id) {
  const t = (x.text || '').replace(/\s+/g, ' ').trim().replace(/^parents need to know that\s+/i, '');
  const end = (v) => (/[.!?]$/.test(v) ? v : `${v}.`);
  if (t && !/…$/.test(t)) {
    const sentence = (t.match(/^.*?[.!?]["”']?(?=\s|$)/)?.[0] || t).replace(/["“”]/g, '').replace(/[.\s]+$/, '');
    if (sentence.length <= 52) return end(sentence);
    const clause = sentence.split(/,|;| — | - | but | and /)[0].trim();
    if (clause.length >= 12 && clause.length <= 52) return end(clause);
  }
  // a generic phrase is only allowed for serious categories (never invent mild content)
  return (x.sev ?? 0) >= 4 ? GENERIC[id]?.[Math.min(5, x.sev)] || '' : '';
}

const NAMES = { violence: 'Violence', sex: 'Sex', language: 'Language' };
const dotOf = (n) => (n >= 4 ? '🔴' : n >= 2 ? '🟠' : '🟢');
const BAND = (age) => (age <= 9 ? 'SAFE' : age <= 14 ? 'SLIGHTLY SAFE' : 'UNSAFE');

// Everything the card needs, computed once (used by the text card, the web card, the API and the badge)
function buildModel(d, imdbId) {
  const f = {};
  for (const { id } of CATS) f[id] = facet(id, d);
  const age = d.csm?.age || null;
  const sevs = CATS.map((c) => f[c.id]?.sev).filter((n) => n != null);

  // label = the worse of (CSM age band) and (category band). Categories are already capped by the age,
  // so a kids' title can never come out "unsafe" because of one badly read line.
  const ageBand = age ? BAND(age) : null;
  let catBand = null;
  if (sevs.length) {
    const m = Math.max(...sevs);
    catBand = m >= 4 ? 'UNSAFE' : m >= 2 ? 'SLIGHTLY SAFE' : 'SAFE';
  }
  let rating = ageBand && catBand ? (RANK[ageBand] >= RANK[catBand] ? ageBand : catBand) : ageBand || catBand || ageOnly(d);
  if (age >= 17) rating = 'UNSAFE';

  const sections = [];
  for (const { id } of CATS) {
    const x = f[id];
    if (!x) continue;
    if (x.sev === 0) continue;                                  // not present
    if (x.sev == null && !x.text) continue;                     // nothing known
    if (x.text && /^(none|not present|n\/a)\b/i.test(x.text.trim())) continue;
    const sev = x.sev ?? textSeverity(x.text) ?? 2;
    const reason = d.brief?.[id] || shortLine(x, id);
    if (!reason) continue;                                      // nothing real to say: skip instead of guessing
    sections.push({ id, name: NAMES[id], sev, emoji: dotOf(sev), reason });
  }
  const url = d.csm?.url || d.site?.url || d.kim?.url || (imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/` : SITE);
  return { rating, age, f, sections, sevs, ageBand, catBand, certs: d.certs || [], url, source: d.csm ? 'Common Sense Media' : d.site ? 'isitsafe.tv' : d.kim ? 'Kids-In-Mind' : d.imdb ? 'IMDb' : 'age ratings' };
}

// Text card for the stream list. style: 'compact' (default) | 'detailed' | 'minimal'
const FULL_CATS = [
  { id: 'violence', name: 'Violence & Scariness' },
  { id: 'sex', name: 'Sex, Romance & Nudity' },
  { id: 'language', name: 'Language' },
  { id: 'drugs', name: 'Drinking, Drugs & Smoking' },
];
function render(d, imdbId, cardUrl, style = 'compact') {
  const m = buildModel(d, imdbId);
  if (!m.rating && !m.sections.length && !m.age) return null;
  const GAP = '\u2800'; // blank-looking line that Nuvio will not trim away
  const key = m.rating || 'NOT RATED';
  const lines = [GAP + MARK[key]];                       // hidden label marker lives in the blank first line

  if (style === 'minimal') {
    // rating only, no descriptions:  Sex  ●●○○○
    const rows = CATS.filter((c) => m.f[c.id]?.sev != null).map((c) => `${bold(NAMES[c.id])}  ${dots(m.f[c.id].sev)}`);
    lines.push(rows.length ? rows.join('\n') : '');
  } else if (style === 'detailed') {
    // everything the Common Sense "Why age N+?" section says, one block per category
    const blocks = [];
    for (const { id, name } of FULL_CATS) {
      const x = facet(id, d, true);
      if (!x || x.sev === 0) continue;
      const text = (x.text || '').trim();
      if (!text && !(x.sev > 0)) continue;
      if (/^(none|not present|n\/a)\b/i.test(text)) continue;
      blocks.push([`${bold(name)}${x.sev != null ? `  ${dots(x.sev)}` : ''}`, text].filter(Boolean).join('\n'));
    }
    if (m.age) lines.push(bold(`Why age ${m.age}+?`), GAP);
    lines.push(blocks.length ? blocks.join(`\n${GAP}\n`) : '🟢 No major concerns');
  } else if (m.sections.length) {
    lines.push(m.sections.map((s) => `${s.emoji} ${bold(s.name)}\n${s.reason}`.trim()).join(`\n${GAP}\n`));
  } else if (m.sevs.length) {
    lines.push('🟢 No major concerns');
  }
  const label = m.rating ? `${ICON[m.rating]} ${bold(m.rating)}` : `⚪ ${bold('NOT RATED')}`;
  return { name: `${label}${m.age ? ` · ${m.age}+` : ''}${MARK[key]}`, description: lines.filter((l) => l !== '').join('\n'), url: cardUrl || m.url };
}

// ---------- graphic badge + web card ----------
const BADGE_COLOR = { SAFE: '#16a34a', 'SLIGHTLY SAFE': '#ea580c', UNSAFE: '#dc2626', 'NOT RATED': '#6b7280' };
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function badgeSvg(key, age) {
  const text = `${key}${age ? ` · ${age}+` : ''}`;
  const w = 64 + text.length * 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="48" viewBox="0 0 ${w} 48" role="img" aria-label="${esc(text)}"><rect width="${w}" height="48" rx="24" fill="${BADGE_COLOR[key]}"/><circle cx="26" cy="24" r="9" fill="#fff" fill-opacity=".92"/><text x="46" y="31" font-family="Arial,Helvetica,sans-serif" font-size="20" font-weight="700" fill="#fff">${esc(text)}</text></svg>`;
}

function cardHtml(m, meta, imdbId, type, origin) {
  const key = m.rating || 'NOT RATED';
  const col = BADGE_COLOR[key];
  const bar = (sev) => Array.from({ length: 5 }, (_, i) => `<i style="background:${i < sev ? (sev >= 4 ? '#dc2626' : sev >= 2 ? '#ea580c' : '#16a34a') : 'var(--track)'}"></i>`).join('');
  const rows = m.sections.length
    ? m.sections.map((s) => `<section><h3><span>${s.emoji} ${esc(s.name)}</span><b class="bar">${bar(s.sev)}</b></h3><p>${esc(s.reason)}</p></section>`).join('')
    : `<section><p>🟢 No major concerns found.</p></section>`;
  const certs = m.certs.map((c) => `${flag(c.c)} ${esc(c.r)}`).join(' &nbsp; ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(NAME)} · ${esc(meta?.name || imdbId)}</title><style>
:root{--bg:#f6f7f9;--card:#fff;--text:#111827;--muted:#6b7280;--track:#e5e7eb}
@media(prefers-color-scheme:dark){:root{--bg:#0b0b0d;--card:#16161a;--text:#f3f4f6;--muted:#9ca3af;--track:#2a2a31}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:520px;margin:0 auto;padding:20px 16px 40px}
.top{display:flex;gap:14px;align-items:center;margin-bottom:18px}.top img{width:64px;border-radius:10px}
h1{font-size:20px;margin:0}.muted{color:var(--muted);font-size:14px}
.badge{display:inline-flex;align-items:center;gap:10px;background:${col};color:#fff;font-weight:800;font-size:22px;padding:10px 20px;border-radius:999px;margin:6px 0 18px}
.badge i{width:16px;height:16px;border-radius:50%;background:#fff;opacity:.92}
.card{background:var(--card);border-radius:18px;padding:6px 18px}
section{padding:14px 0;border-bottom:1px solid var(--track)}section:last-child{border:0}
h3{display:flex;justify-content:space-between;align-items:center;margin:0 0 4px;font-size:17px}
.bar{display:inline-flex;gap:4px}.bar i{width:18px;height:8px;border-radius:4px}
p{margin:0;color:var(--muted)}a{color:inherit}details{margin-top:18px}pre{white-space:pre-wrap;word-break:break-all;font-size:12px}
</style></head><body><main>
<div class="top">${meta?.poster ? `<img src="${esc(meta.poster)}" alt="">` : ''}<div><h1>${esc(meta?.name || imdbId)}</h1><div class="muted">${esc(meta?.year || meta?.releaseInfo || '')}${m.age ? ` · Common Sense age ${m.age}+` : ''}</div></div></div>
<div class="badge"><i></i>${esc(key)}${m.age ? ` · ${m.age}+` : ''}</div>
<div class="card">${rows}</div>
${certs ? `<p class="muted" style="margin-top:14px">${certs}</p>` : ''}
<p class="muted" style="margin-top:14px">Estimated from ${esc(m.source)}. <a href="${esc(m.url)}">Open source page</a></p>
<details><summary class="muted">For developers</summary><pre>JSON:   ${esc(`${origin}/api/${type}/${imdbId}.json`)}
Badge:  ${esc(`${origin}/badge/${type}/${imdbId}.svg`)}
Labels: ${esc(`${origin}/labels.json`)}</pre></details>
</main></body></html>`;
}

const REGEX_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SafeNest label regex</title>
<style>body{font:16px/1.45 system-ui,sans-serif;margin:auto;padding:18px;max-width:560px;background:#0b0b0d;color:#f3f4f6}
input,select,button{font:inherit;padding:10px;border-radius:10px;border:1px solid #333;background:#16161a;color:inherit}button{background:#2563eb;border:0}
code{background:#16161a;padding:2px 6px;border-radius:6px;font-size:13px;word-break:break-all}.row{display:flex;gap:10px;align-items:center;margin:8px 0;flex-wrap:wrap}
.ok{outline:3px solid #22c55e;border-radius:12px;padding:4px}pre{white-space:pre-wrap;background:#16161a;padding:10px;border-radius:10px}img{height:40px}</style></head><body>
<h2>How the hidden label works</h2>
<p>Every card ends its top line with 4 invisible characters. Each label has its own pattern, so a program can find it with a regex and show the matching badge.</p>
<div id="list"></div>
<h3>Try it on a real title</h3>
<div class="row"><input id="id" value="tt1375666" size="12"><select id="t"><option>movie</option><option>series</option></select><button onclick="go()">Check</button></div>
<div id="out"></div>
<script>
var L={'SAFE':'safe','SLIGHTLY SAFE':'slightly-safe','UNSAFE':'unsafe','NOT RATED':'not-rated'},R={};
function rid(k){return 'r-'+k.replace(' ','_')}
fetch('/labels.json').then(function(r){return r.json()}).then(function(j){R=j;document.getElementById('list').innerHTML=Object.keys(L).map(function(k){return '<div class="row" id="'+rid(k)+'"><img src="/badge/'+L[k]+'.svg"><code>'+R[k]+'</code></div>'}).join('')});
async function go(){
 var out=document.getElementById('out'),t=document.getElementById('t').value,id=document.getElementById('id').value;
 var j=await (await fetch('/stream/'+t+'/'+id+'.json')).json();var s=j.streams&&j.streams[0];
 if(!s){out.textContent='No card for this title yet (try again in a few seconds).';return}
 document.querySelectorAll('.row').forEach(function(e){e.classList.remove('ok')});
 var hit='none';Object.keys(L).forEach(function(k){if(new RegExp(R[k]).test(s.name)){hit=k;document.getElementById(rid(k)).classList.add('ok')}});
 var shown=s.name.replace(/[\\u2060\\u200B\\u200C]/g,function(c){return {'\\u2060':'[WJ]','\\u200B':'[0]','\\u200C':'[1]'}[c]});
 out.innerHTML='<p>Matched label: <b>'+hit+'</b></p><img src="/badge/'+t+'/'+id+'.svg"><pre></pre><p>Same data as JSON: <code>/api/'+t+'/'+id+'.json</code></p>';
 out.querySelector('pre').textContent=shown;
}
</script></body></html>
`;

const STYLE_INFO = {
  compact: { id: 'community.safenest.family', name: NAME },
  detailed: { id: 'community.safenest.detailed', name: `${NAME} Detailed` },
  minimal: { id: 'community.safenest.minimal', name: `${NAME} Minimal` },
};
const manifestFor = (style) => ({ ...MANIFEST, ...STYLE_INFO[style] });

// ---------- per-user settings (style, own TMDB key, countries) packed into the install link ----------
const b64u = {
  enc: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};
const aesKey = async (secret) =>
  crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);

function sanitizeConfig(c) {
  const out = {};
  if (['compact', 'detailed', 'minimal'].includes(c?.s)) out.s = c.s;
  if (typeof c?.t === 'string' && /^[a-f0-9]{32}$/i.test(c.t.trim())) out.t = c.t.trim();
  if (typeof c?.c === 'string' && /^[A-Z]{2}(,[A-Z]{2}){0,7}$/.test(c.c.trim())) out.c = c.c.trim();
  return out;
}
// with a CONFIG_SECRET the token is encrypted (the TMDB key is not readable in the link); without it, plain base64
async function encodeConfig(cfg, env) {
  const raw = new TextEncoder().encode(JSON.stringify(cfg));
  if (!env?.CONFIG_SECRET) return `p${b64u.enc(raw)}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env.CONFIG_SECRET), raw));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return `e${b64u.enc(out)}`;
}
async function decodeConfig(token, env) {
  try {
    const bytes = b64u.dec(token.slice(1));
    let raw;
    if (token[0] === 'p') raw = bytes;
    else if (token[0] === 'e' && env?.CONFIG_SECRET) {
      raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await aesKey(env.CONFIG_SECRET), bytes.slice(12)));
    } else return null;
    return sanitizeConfig(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    return null;
  }
}

// Sample title used by the landing page to preview the three card styles with the real renderer
const SAMPLE = {
  csm: {
    age: 12,
    url: 'https://www.commonsensemedia.org/',
    violence: { score: null, level: null, text: 'Lots of cartoonish violence. Characters are flattened, blown up and shot, but they bounce back.' },
    sex: { score: null, level: null, text: "Cameron Diaz's cleavage is its own character. A suggestive dance number." },
    language: { score: null, level: 'some', text: 'Some profanity. "S--t," "damn" and "hell" are heard.' },
    drugs: { score: null, level: null, text: 'A character smokes a cigar. Brief drinking at a nightclub.' },
  },
  site: null, kim: null, imdb: null, certs: [],
  brief: { violence: 'Lots of cartoonish violence.', sex: 'Cleavage jokes and a suggestive dance.', language: 'Some mild profanity.' },
};

// ---------- routing ----------
export default {
  async scheduled(event, env, ctx) {
    if (env.CACHE) ctx.waitUntil(prewarm(env));
  },

  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
};

async function handle(request, env, ctx) {
  {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const { pathname: rawPath, origin } = new URL(request.url);
    let pathname = rawPath;
    // /manifest.json = compact, /detailed/manifest.json, /minimal/manifest.json (/safenest and /compact are aliases of the default)
    let style = 'compact';
    // personal install link: /c/<token>/manifest.json  (token = style + optional own TMDB key + countries)
    const cm = pathname.match(/^\/c\/([A-Za-z0-9_-]+)(?=\/)/);
    if (cm) {
      const cfg = await decodeConfig(cm[1], env);
      pathname = pathname.slice(cm[0].length);
      if (cfg) {
        style = cfg.s || 'compact';
        env = { ...env, ...(cfg.t ? { TMDB_API_KEY: cfg.t } : {}), ...(cfg.c ? { AGE_COUNTRIES: cfg.c } : {}) };
      }
    }
    const sm = pathname.match(/^\/(safenest|compact|classic|detailed|minimal)(?=\/)/);
    if (sm) {
      if (sm[1] === 'detailed' || sm[1] === 'minimal') style = sm[1];
      pathname = pathname.slice(sm[0].length);
    }

    if (pathname === '/') {
      return new Response('SafeNest addon. Add /manifest.json to Nuvio. Regex demo: /regex', { headers: { 'content-type': 'text/plain', ...CORS } });
    }
    if (pathname === '/manifest.json') return json(manifestFor(style));
    if (pathname === '/labels.json') return json(MARK_REGEX);

    // landing page helpers: build a personal link, preview a style
    if (pathname === '/api/config' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const cfg = sanitizeConfig(body);
      let keyValid = null;
      if (cfg.t) keyValid = !!(await getJson(`https://api.themoviedb.org/3/configuration?api_key=${cfg.t}`));
      const token = await encodeConfig(cfg, env);
      return json({ token, path: `/c/${token}/manifest.json`, encrypted: !!env?.CONFIG_SECRET, keyValid, style: cfg.s || 'compact' });
    }
    const pv = pathname.match(/^\/api\/preview\/(compact|detailed|minimal)\.json$/);
    if (pv) return json(render(SAMPLE, 'tt0110475', undefined, pv[1]), 200, { 'cache-control': 'public, max-age=3600' });
    if (pathname === '/regex') return new Response(REGEX_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS } });

    // Static badge for a label:  /badge/UNSAFE.svg?age=12   (also SAFE, SLIGHTLY-SAFE, NOT-RATED)
    const bl = pathname.match(/^\/badge\/(SAFE|SLIGHTLY-SAFE|UNSAFE|NOT-RATED)\.svg$/i);
    if (bl) {
      const age = Number(new URL(request.url).searchParams.get('age')) || null;
      return new Response(badgeSvg(bl[1].toUpperCase().replace('-', ' '), age), { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', ...CORS } });
    }

    // Per-title pages: /card/movie/tt123 (graphic card), /api/movie/tt123.json (data), /badge/movie/tt123.svg (badge)
    const pt = pathname.match(/^\/(card|api|badge)\/(movie|series)\/(tt\d+)(?:\.(?:json|svg))?$/);
    if (pt) {
      const [, kind, type, imdb] = pt;
      const meta = await getCinemeta(type, imdb);
      const r = meta ? await withCerts(await lookup(type, imdb, ctx, env, meta), type, imdb, env) : null;
      const model = r ? buildModel(r.data, imdb) : null;
      const cc = { 'cache-control': r?.partial ? 'no-store' : 'public, max-age=300' };
      if (!model || (!model.rating && !model.sections.length && !model.age)) {
        return kind === 'api' ? json({ error: 'no data' }, 404) : new Response('No safety data found for this title yet.', { status: 404, headers: { 'content-type': 'text/plain', ...CORS } });
      }
      if (kind === 'api') return json({ id: imdb, type, name: meta.name, label: model.rating || 'NOT RATED', age: model.age, categories: model.sections.map(({ id, name, sev, emoji, reason }) => ({ id, name, sev, emoji, reason })), certs: model.certs, source: model.source, url: model.url, card: `${origin}/card/${type}/${imdb}` }, 200, cc);
      if (kind === 'badge') return new Response(badgeSvg(model.rating || 'NOT RATED', model.age), { headers: { 'content-type': 'image/svg+xml', ...cc, ...CORS } });
      return new Response(cardHtml(model, meta, imdb, type, origin), { headers: { 'content-type': 'text/html; charset=utf-8', ...cc, ...CORS } });
    }

    // Diagnostic: /debug/movie/tt1375666  (runs every source live and shows cache status)
    const dbg = pathname.match(/^\/debug\/(movie|series)\/(tt\d+)$/);
    if (dbg) {
      const [, type, imdb] = dbg;
      const meta = await getCinemeta(type, imdb);
      if (!meta) return json({ error: 'Cinemeta has no such title' });
      const rec = await readStore(keyOf(type, imdb), env);
      const tried = { site: [], kim: [], imdb: [], csm: [] };
      const t0 = Date.now();
      const { data, done } = collect(type, imdb, meta, env, tried);
      await done;
      data.certs = await findCerts(type, imdb, env);
      return json({
        name: meta.name,
        year: yearOf(meta),
        tmdbKeySet: !!env?.TMDB_API_KEY,
        kvBound: !!env?.CACHE,
        cachedBeforeThisCall: rec ? { ageMinutes: Math.round((Date.now() - rec.at) / 60000) } : null,
        liveFetchMs: Date.now() - t0,
        tried,
        found: { site: !!data.site, kim: !!data.kim, imdb: data.imdb, csm: data.csm, certs: data.certs },
        model: (() => { const md = buildModel(data, imdb); return { rating: md.rating, age: md.age, ageBand: md.ageBand, catBand: md.catBand, sections: md.sections.map((x) => ({ id: x.id, sev: x.sev, reason: x.reason })) }; })(),
        shown: render(data, imdb, undefined, style),
      });
    }

    const m = pathname.match(/^\/(stream|meta)\/(movie|series)\/(.+)\.json$/);
    if (!m) return json({ error: 'not found' }, 404);
    const [, resource, type, rawId] = m;
    const imdb = decodeURIComponent(rawId).split(':')[0];
    if (!/^tt\d+$/.test(imdb)) return json(resource === 'stream' ? { streams: [] } : { meta: null });

    if (resource === 'stream') {
      const r = await withCerts(await lookup(type, imdb, ctx, env), type, imdb, env);
      const cc = { 'cache-control': r?.partial ? 'no-store' : 'public, max-age=60' };
      const out = r && render(r.data, imdb, undefined, style);   // no card override: tapping opens the source page (Common Sense etc.)
      if (!out) return json({ streams: [] }, 200, { 'cache-control': 'no-store' });
      const mm = buildModel(r.data, imdb);
      const info = { label: mm.rating || 'NOT RATED', age: mm.age, categories: Object.fromEntries(mm.sections.map((x) => [x.id, x.sev])), card: `${origin}/card/${type}/${imdb}`, source: out.url };
      return json({ streams: [{ name: out.name, description: out.description, externalUrl: out.url, safenest: info }] }, 200, cc);
    }

    const meta = await getCinemeta(type, imdb);
    if (!meta) return json({ meta: null });
    const r = await withCerts(await lookup(type, imdb, ctx, env, meta), type, imdb, env);
    const out = r && render(r.data, imdb, undefined, style);
    if (out) meta.description = `${out.name}\n${out.description}\n\n${meta.description || ''}`.trim();
    return json({ meta }, 200, { 'cache-control': r?.partial ? 'no-store' : 'public, max-age=60' });
  }
}
