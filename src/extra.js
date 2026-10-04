// Extra sources (best effort, regex only). Both can fail silently; /debug/... shows why.
import { slugify } from './kim.js';

const GUIDE_IDS = ['NUDITY', 'VIOLENCE', 'PROFANITY', 'ALCOHOL', 'FRIGHTENING'];
const SEV = '(None|Mild|Moderate|Severe)';
const NOT_OTHER_ID = '(?:(?!"id":"(?:NUDITY|VIOLENCE|PROFANITY|ALCOHOL|FRIGHTENING)")[\\s\\S])';

// IMDb parents guide: severity per category, e.g. { nudity: 'Mild', violence: 'Moderate' }
export function parseImdbGuide(html) {
  const out = {};
  for (const id of GUIDE_IDS) {
    let m = html.match(new RegExp(`"id":"${id}"${NOT_OTHER_ID}{0,500}?"severity"${NOT_OTHER_ID}{0,200}?"text":"${SEV}"`));
    if (!m) m = html.match(new RegExp(`sub-section-${id.toLowerCase()}[\\s\\S]{0,1500}?${SEV}`, 'i'));
    if (m) out[id.toLowerCase()] = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  }
  return Object.keys(out).length ? out : null;
}

// Common Sense Media: recommended age + content grid (Sex, Romance & Nudity etc., scored 0-5).
// The grid markup is not verified, so scores/text are best effort; /debug shows the raw HTML slice.
const AMP = '(?:&amp;|&)';
const GRID = {
  sex: new RegExp(`(?<=>)\\s*Sex,\\s*Romance\\s*${AMP}\\s*Nudity\\s*(?=<)`, 'i'),
  violence: new RegExp(`(?<=>)\\s*Violence\\s*${AMP}\\s*Scariness\\s*(?=<)`, 'i'),
  drugs: new RegExp(`(?<=>)\\s*Drinking,\\s*Drugs\\s*${AMP}\\s*Smoking\\s*(?=<)`, 'i'),
  language: /(?<=>)\s*Language\s*(?=<)/,
};
const NEXT_LABEL = new RegExp(
  `(?<=>)\\s*(?:Sex,\\s*Romance\\s*${AMP}\\s*Nudity|Violence\\s*${AMP}\\s*Scariness|Drinking,\\s*Drugs\\s*${AMP}\\s*Smoking|Language|Products\\s*${AMP}\\s*Purchases)\\s*(?=<)`,
  'i',
);

const decode = (h) =>
  h
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;|&#0?34;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

// html -> clean text. Decodes twice so escaped markup (&lt;/p&gt;) is removed too.
const plain = (h) => {
  let t = h;
  for (let i = 0; i < 2; i++) t = decode(t);
  return t
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s*["']\s*>+\s*/g, ' ') // leftovers of a tag that started before our slice
    .replace(/\s+/g, ' ')
    .trim();
};
const tidy = (t) =>
  t
    .replace(/\s+'s\b/g, "'s")        // "Diaz 's" -> "Diaz's"
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

// The grid row only holds a short preview (~80 characters). Look for the same sentence elsewhere in the
// page (expanded panel / embedded JSON) and use the longest version found.
function expandText(html, preview) {
  const prefix = preview.slice(0, 45).split(/[,'"&]/)[0].trim();
  if (prefix.length < 20) return preview;
  let best = preview;
  let from = 0;
  for (let n = 0; n < 12; n++) {
    const i = html.indexOf(prefix, from);
    if (i < 0) break;
    from = i + prefix.length;
    let chunk = html.slice(i, i + 900).replace(/\\u0027/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ' ');
    chunk = decode(decode(chunk));                       // escaped tags become real tags, then we stop at the first one
    const stop = chunk.search(/<|"\s*[,}\]>]/);
    if (stop > 0) chunk = chunk.slice(0, stop);
    const t = tidy(plain(chunk));
    if (t.length > best.length && t.startsWith(preview.slice(0, 20))) best = t;
  }
  return best;
}

// Common Sense also prints an intensity word before each description ("some", "a lot" ...)
// (no "i" flag on purpose: the text after the word must start with a capital, so "Lots of violence" stays intact)
const LEVELS = /^([Nn]ot present|[Nn]one|[Aa] little|[Ss]ome|[Aa] lot|[Ll]ots)\s+(?=[A-Z"“])/;

function gridItem(html, re, from = 0) {
  const m = re.exec(html.slice(from));
  if (!m) return null;
  const start = from + m.index + m[0].length;
  const rest = html.slice(start, start + 3000);
  const nx = rest.search(NEXT_LABEL);
  const seg = nx >= 0 ? rest.slice(0, nx) : rest.slice(0, 2000);

  // numeric score 0-5 only from an explicit statement (anything looser proved unreliable)
  let score = null;
  const explicit =
    seg.match(/(\d)\s*(?:out of|\/)\s*5/i) ||
    seg.match(/(?:data-(?:rating|score|value|level)|aria-valuenow)=["'](\d)["']/i);
  if (explicit) score = Number(explicit[1]);
  if (score !== null && (score < 0 || score > 5)) score = null;

  let text = tidy(
    plain(seg)
      .replace(/\d\s*(?:out of|\/)\s*5(?:\s*stars?)?/gi, '')
      .replace(/\b(?:read|show|see) more\b/gi, ''),
  );
  let level = null;
  const lv = text.match(LEVELS);
  if (lv) {
    level = lv[1].toLowerCase();
    text = text.slice(lv[0].length);
  }
  if (text.length < 12) text = '';
  else text = tidy(expandText(html, text));
  return { score, text, level, index: from + m.index };
}

export function parseCsm(html, name, url) {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '';
  if (!/common sense/i.test(title) || !slugify(title).includes(slugify(name))) return null;
  const age = (html.match(/Why\s+Age\s*(\d{1,2})\s*\+/i) || html.match(/\bage\s*(\d{1,2})\+/i))?.[1];

  const sex = gridItem(html, GRID.sex);
  const violence = gridItem(html, GRID.violence);
  const drugs = gridItem(html, GRID.drugs);
  const language = gridItem(html, GRID.language, violence?.index || 0);
  const pick = (g) => (g && (g.score !== null || g.text || g.level) ? { score: g.score, text: g.text, level: g.level } : null);
  if (!age && !pick(sex) && !pick(violence)) return null;
  return { age: age ? Number(age) : null, url, sex: pick(sex), violence: pick(violence), drugs: pick(drugs), language: pick(language), rawFrom: sex?.index ?? null };
}
