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
const KEY = 'v10';
const NAME = 'SafeNest'; // addon name shown in Nuvio (change here)

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MANIFEST = {
  id: 'community.safenest.family',
  version: '7.3.0',
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
      if (tried) { // debug only: raw HTML around the content grid
        const i = html.search(/Sex,\s*Romance/i);
        tried.push({ gridLabelFound: i >= 0, htmlLength: html.length, rawSlice: i >= 0 ? html.slice(Math.max(0, i - 300), i + 1500) : null });
      }
      const rec = parseCsm(html, meta.name, url);
      if (rec) delete rec.rawFrom;
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
  const certP = run(findCerts(type, imdb, env), (v) => (data.certs = v || []));
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
  return { data, done: Promise.all([csmP, certP, fallbackP, briefP]) };
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
  if (/mild|brief|infrequent|occasional|cartoon|slapstick|kiss|innuendo|cleavage|some |a little|minor|implied|suggestive/.test(t)) return 2;
  return 3;
}
// Common Sense intensity words -> 0-5
const LEVEL_SEV = { 'not present': 0, none: 0, 'a little': 1, some: 3, 'a lot': 5, lots: 5 };
// CSM age caps how severe a category can plausibly be (guards against a mis-read number)
const capByAge = (n, age) => (age ? Math.min(n, age <= 7 ? 1 : age <= 11 ? 3 : age <= 13 ? 3 : age <= 15 ? 4 : 5) : n);
const sevOfSite = (r) => ({ SAFE: 0, 'SLIGHTLY SAFE': 2, UNSAFE: 4 })[r] ?? null;
const sevOfImdb = (s) => ({ None: 0, Mild: 2, Moderate: 3, Severe: 5 })[s] ?? null;

const CATS = [
  { id: 'violence', label: 'Violence & Scariness' },
  { id: 'sex', label: 'Sex, Romance & Nudity' },
  { id: 'language', label: 'Language' },
];

// One category: Common Sense first, then isitsafe.tv / Kids-In-Mind / IMDb as fallbacks
function facet(id, d) {
  const c = [];
  const cs = d.csm?.[id];
  if (cs) {
    const sev = LEVEL_SEV[cs.level] ?? (cs.text ? textSeverity(cs.text) : null) ?? (cs.score != null ? capByAge(cs.score, d.csm?.age) : null);
    c.push({ sev, text: cs.text || '' });
  }
  if (id === 'sex') {
    if (d.site) {
      const reasons = d.site.reasons?.length ? d.site.reasons : [d.site.summary].filter(Boolean);
      c.push({ sev: sevOfSite(d.site.rating), text: reasons.length ? `${briefReasons(reasons)}.` : '' });
    }
    if (d.kim) c.push({ sev: Math.round(d.kim.sex / 2), text: d.kim.snippet || '' });
    if (d.imdb?.nudity) c.push({ sev: sevOfImdb(d.imdb.nudity), text: '' });
  } else if (id === 'violence') {
    if (d.kim) c.push({ sev: Math.round(d.kim.violence / 2), text: '' });
    if (d.imdb?.violence) c.push({ sev: sevOfImdb(d.imdb.violence), text: '' });
  } else if (id === 'language') {
    if (d.kim) c.push({ sev: Math.round(d.kim.language / 2), text: '' });
    if (d.imdb?.profanity) c.push({ sev: sevOfImdb(d.imdb.profanity), text: '' });
  }
  const sev = c.find((x) => x.sev != null)?.sev ?? null;
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
  if (t) {
    const sentence = (t.match(/^.*?[.!?](?=\s|$)/)?.[0] || t).replace(/[.\s]+$/, '');
    if (sentence.length <= 52) return `${sentence}.`;
    const clause = sentence.split(/,|;| — | - | but | and /)[0].trim();
    if (clause.length >= 12 && clause.length <= 52) return `${clause}.`;
  }
  return GENERIC[id]?.[Math.max(0, Math.min(5, x.sev ?? 3))] || '';
}

function render(d, imdbId) {
  const f = {};
  for (const { id } of CATS) f[id] = facet(id, d);
  const age = d.csm?.age || null;

  // overall label: worst category (0-1 safe, 2-3 slightly, 4-5 unsafe); age 17+ is always unsafe
  const sevs = CATS.map((c) => f[c.id]?.sev).filter((n) => n != null);
  let rating = null;
  if (sevs.length) {
    const m = Math.max(...sevs);
    rating = m >= 4 ? 'UNSAFE' : m >= 2 ? 'SLIGHTLY SAFE' : 'SAFE';
    if (age >= 17) rating = 'UNSAFE';
  } else {
    rating = ageOnly(d);
  }

  const GAP = '\u2800'; // blank-looking line that Nuvio will not trim away
  const dot = (n) => (n >= 4 ? '🔴' : n >= 2 ? '🟠' : '🟢');
  const NAMES = { violence: 'Violence', sex: 'Sex', language: 'Language' };

  // sections: skip categories with no data or nothing present; bold title with coloured emoji + one short line
  const sections = [];
  for (const { id } of CATS) {
    const x = f[id];
    if (!x) continue;
    if (x.sev === 0) continue;
    if (x.sev == null && !x.text) continue;
    if (x.text && /^(none|not present|n\/a)\b/i.test(x.text.trim())) continue;
    const reason = d.brief?.[id] || shortLine(x, id);
    sections.push([`${dot(x.sev ?? textSeverity(x.text) ?? 2)} ${bold(NAMES[id])}`, reason].filter(Boolean).join('\n'));
  }
  const key = rating || 'NOT RATED';
  const lines = [GAP + MARK[key]];                       // hidden label marker lives in the blank first line
  if (sections.length) lines.push(sections.join(`\n${GAP}\n`));
  else if (sevs.length) lines.push('🟢 No major concerns');

  const url = d.csm?.url || d.site?.url || d.kim?.url || (imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/` : SITE);
  if (!rating && lines.length <= 1 && !age) return null;
  const label = rating ? `${ICON[rating]} ${bold(rating)}` : `⚪ ${bold('NOT RATED')}`;
  return { name: `${label}${age ? ` · ${age}+` : ''}${MARK[key]}`, description: lines.join('\n'), url };
}

// ---------- routing ----------
export default {
  async scheduled(event, env, ctx) {
    if (env.CACHE) ctx.waitUntil(prewarm(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    let { pathname } = new URL(request.url);
    // /safenest/manifest.json is a fresh install URL; old links with a style prefix keep working
    pathname = pathname.replace(/^\/(safenest|compact|classic|detailed|minimal)(?=\/)/, '');

    if (pathname === '/') {
      return new Response('IsItSafe addon. Add /manifest.json to Nuvio.', { headers: { 'content-type': 'text/plain', ...CORS } });
    }
    if (pathname === '/manifest.json') return json(MANIFEST);
    if (pathname === '/labels.json') return json(MARK_REGEX);

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
      return json({
        name: meta.name,
        year: yearOf(meta),
        tmdbKeySet: !!env?.TMDB_API_KEY,
        kvBound: !!env?.CACHE,
        cachedBeforeThisCall: rec ? { ageMinutes: Math.round((Date.now() - rec.at) / 60000) } : null,
        liveFetchMs: Date.now() - t0,
        tried,
        found: { site: !!data.site, kim: !!data.kim, imdb: data.imdb, csm: data.csm, certs: data.certs },
        shown: render(data, imdb),
      });
    }

    const m = pathname.match(/^\/(stream|meta)\/(movie|series)\/(.+)\.json$/);
    if (!m) return json({ error: 'not found' }, 404);
    const [, resource, type, rawId] = m;
    const imdb = decodeURIComponent(rawId).split(':')[0];
    if (!/^tt\d+$/.test(imdb)) return json(resource === 'stream' ? { streams: [] } : { meta: null });

    if (resource === 'stream') {
      const r = await lookup(type, imdb, ctx, env);
      const cc = { 'cache-control': r?.partial ? 'no-store' : 'public, max-age=60' };
      const out = r && render(r.data, imdb);
      if (!out) return json({ streams: [] }, 200, { 'cache-control': 'no-store' });
      return json({ streams: [{ name: out.name, description: out.description, externalUrl: out.url }] }, 200, cc);
    }

    const meta = await getCinemeta(type, imdb);
    if (!meta) return json({ meta: null });
    const r = await lookup(type, imdb, ctx, env, meta);
    const out = r && render(r.data, imdb);
    if (out) meta.description = `${out.name}\n${out.description}\n\n${meta.description || ''}`.trim();
    return json({ meta }, 200, { 'cache-control': r?.partial ? 'no-store' : 'public, max-age=60' });
  },
};
