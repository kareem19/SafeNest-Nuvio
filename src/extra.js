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

// ---------- Common Sense Media ----------
// Reads ONLY the "Why Age N+?" grid (Violence, Language, Drinking/Drugs, Sex), as plain text, in the order the
// labels appear. Everything that is not a statement about the title (questions, buttons, user-review headings,
// text that belongs to another category) is removed.
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
    .replace(/\s*["']\s*>+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};
const tidy = (t) =>
  t
    .replace(/\s+'s\b/g, "'s")
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const TERMINAL = /[.!?]["”')\]]*$/;
const splitSentences = (t) => (t.match(/[^.!?]+(?:[.!?]+["”')\]]*|$)/g) || []).map((x) => x.trim()).filter(Boolean);

const LABELS = [
  ['violence', 'Violence & Scariness'],
  ['language', 'Language'],
  ['drugs', 'Drinking, Drugs & Smoking'],
  ['sex', 'Sex, Romance & Nudity'],
  ['products', 'Products & Purchases'],
];
// headings of other page sections: everything from here on is not part of the category
const FOREIGN = /Any Positive Content\?|Positive Messages|Positive Role Models|Parent reviews?|Kid reviews?|Parents say|Kids say|Talk to your kids|Families can talk|Is it any good\?|What's the story\?|Show spoilers|Add your rating|Was this review helpful/i;
// intensity word printed before a description ("some", "a lot" ...): kept as `level`, removed from the text
const LEVELS = /^([Nn]ot present|[Nn]one|[Vv]ery little|[Aa] little|[Ll]ittle|[Ss]ome|[Qq]uite a bit|[Aa] lot|[Ll]ots)\s+(?=[A-Z"“'])/;
// which category a sentence belongs to, used when the same sentence shows up under two labels
const OWN = {
  violence: /violen|kill|shoot|fight|blood|gore|weapon|\bgun|death|\bdie|peril|scar|frighten|threat|attack|explo|punch|crash|monster|danger|menac|slapstick|cartoon|chase|\bhit\b/i,
  sex: /\bsex|nudity|nude|naked|cleavage|kiss|romanc|romantic|innuendo|lingerie|underwear|flirt|breast|\bbare\b|affair|virgin|seduc|undress|bikini|make ?out/i,
  language: /profan|swear|curs|\bwords?\b|language|damn|\bhell\b|s--t|f--k|bitch|a--|cuss|insult|name-?calling/i,
  drugs: /drink|drunk|alcohol|beer|wine|smok|cigar|drug|cocaine|marijuana|\bpot\b|vap|booze|liquor|tobacco|\bhigh\b/i,
};

function cleanSegment(raw) {
  let score = null;
  const sm = raw.match(/(\d)\s*(?:out of|\/)\s*5/i);
  if (sm) score = Number(sm[1]);
  let t = raw
    .replace(/\d\s*(?:out of|\/)\s*5(?:\s*stars?)?/gi, ' ')
    .replace(/Did you know you can flag iffy content\?/gi, ' ')
    .replace(/Adjust limits for [^.]{0,80}?entertainment guide\.?/gi, ' ')
    .replace(/\bGet started\b/g, ' ')
    .replace(/\b(?:Read|Show|See) more\b/gi, ' ');
  t = t.split(FOREIGN)[0];
  t = tidy(t).replace(/\s*\bClose\b\s*$/, '');
  let level = null;
  let m;
  while ((m = t.match(LEVELS))) {
    level = m[1].toLowerCase();
    t = t.slice(m[0].length);
  }
  let ss = splitSentences(t).filter((x) => !/\?["”')\]]*$/.test(x)); // questions are never a description
  ss = ss.filter((x, i) => ss.findIndex((y) => norm(y) === norm(x)) === i);
  ss = ss.filter((x, i) => !ss.some((y, j) => j !== i && y.length > x.length && norm(y).startsWith(norm(x))));
  return { score, level, sentences: ss };
}

// The row only keeps a short preview; if the full sentence exists verbatim elsewhere in the page, use it.
function expandFragment(html, frag) {
  if (frag.length < 30) return null;
  const big = decode(decode(html));
  let from = 0;
  for (let n = 0; n < 8; n++) {
    const i = big.indexOf(frag, from);
    if (i < 0) return null;
    from = i + frag.length;
    const tail = big.slice(i + frag.length, i + frag.length + 400);
    const stop = tail.search(/</);
    const ext = (stop >= 0 ? tail.slice(0, stop) : tail).match(/^[^.!?]*[.!?]["”')\]]*/)?.[0];
    if (!ext) continue;
    const cand = tidy(plain(frag + ext));
    if (cand.length > frag.length + 1 && cand.length < 300 && TERMINAL.test(cand) && !/\?$/.test(cand) && !FOREIGN.test(cand)) return cand;
  }
  return null;
}

function finish(c, html) {
  let ss = c.sentences;
  if (ss.length && !TERMINAL.test(ss[ss.length - 1])) {
    const last = ss[ss.length - 1];
    const full = expandFragment(html, last);
    if (full) ss = [...ss.slice(0, -1), full];
    else if (ss.length > 1) ss = ss.slice(0, -1);               // drop the cut-off tail, keep the complete sentences
    else ss = [last.replace(/\s+\S*$/, '') + '…'];              // only a cut-off preview exists: mark it
  }
  const text = ss.join(' ').trim();
  if (text.length < 8 && !text.includes('…')) return c.level || c.score != null ? { score: c.score, text: '', level: c.level } : null;
  if (/^(none|not present|n\/a)\b/i.test(text)) return { score: c.score, text: '', level: c.level || 'none' };
  return { score: c.score, text, level: c.level };
}


// The dots' own number, only when the page states it explicitly right after the label (aria-label, data attribute,
// "N out of 5"). Star ratings ("4 out of 5 stars") and anything beyond the next label are ignored.
const RAW_LABEL = {
  violence: /Violence\s*(?:&amp;|&)\s*Scariness/i,
  language: /(?<![A-Za-z])Language(?![A-Za-z])/,
  drugs: /Drinking,\s*Drugs\s*(?:&amp;|&)\s*Smoking/i,
  sex: /Sex,\s*Romance\s*(?:&amp;|&)\s*Nudity/i,
};
const RAW_ANY = /Violence\s*(?:&amp;|&)\s*Scariness|Drinking,\s*Drugs\s*(?:&amp;|&)\s*Smoking|Sex,\s*Romance\s*(?:&amp;|&)\s*Nudity|Products\s*(?:&amp;|&)\s*Purchases|(?<![A-Za-z])Language(?![A-Za-z])/gi;
function rawScore(html, id, from) {
  const m = RAW_LABEL[id].exec(html.slice(from));
  if (!m) return null;
  const start = from + m.index + m[0].length;
  const win = html.slice(start, start + 700);
  const next = win.search(new RegExp(RAW_ANY.source, 'i'));
  const seg = next > 0 ? win.slice(0, next) : win;
  const hit =
    seg.match(/(?:aria-label|title|alt)=["'][^"']*?\b(\d)\s*(?:out of|\/)\s*5\b(?!\s*stars?)/i) ||
    seg.match(/(?:data-(?:rating|score|value|level)|aria-valuenow)=["'](\d)["']/i) ||
    seg.match(/\b(\d)\s*(?:out of|\/)\s*5\b(?!\s*stars?)/i);
  const n = hit ? Number(hit[1]) : null;
  return n !== null && n >= 0 && n <= 5 ? n : null;
}

export function parseCsm(html, name, url, debug = false) {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '';
  if (!/common sense/i.test(title) || !slugify(title).includes(slugify(name))) return null;

  const start = html.search(/Why\s+Age\s*\d{1,2}\s*\+/i);
  const ageM = (start >= 0 ? html.slice(start, start + 60).match(/(\d{1,2})\s*\+/) : null) || html.match(/\bage\s*(\d{1,2})\+/i);
  const age = ageM ? Number(ageM[1]) : null;

  const out = { age, url, violence: null, sex: null, language: null, drugs: null };
  let region = '';
  if (start >= 0) {
    region = plain(html.slice(start, start + 80000));
    const found = LABELS.map(([id, label]) => ({ id, label, pos: region.indexOf(label) }))
      .filter((x) => x.pos >= 0)
      .sort((a, b) => a.pos - b.pos);
    const cats = {};
    found.forEach((x, i) => {
      if (x.id === 'products') return;
      const from = x.pos + x.label.length;
      const to = Math.min(found[i + 1] ? found[i + 1].pos : from + 700, from + 900);
      cats[x.id] = cleanSegment(region.slice(from, to));
    });
    const ids = Object.keys(cats);

    // a sentence glued onto the end of another category's cut-off preview: split it off
    for (const id of ids) {
      cats[id].sentences = cats[id].sentences.map((s) => {
        for (const other of ids) {
          if (other === id) continue;
          for (const t of cats[other].sentences) {
            if (t.length >= 15 && s.length > t.length + 10 && s.endsWith(t)) return s.slice(0, -t.length).trim();
          }
        }
        return s;
      }).filter(Boolean);
    }
    // the same sentence under two labels: keep it where it belongs
    const owner = new Map();
    for (const id of ids) {
      for (const s of cats[id].sentences) {
        const k = norm(s);
        const prev = owner.get(k);
        if (!prev) owner.set(k, id);
        else if (!OWN[prev]?.test(s) && OWN[id]?.test(s)) owner.set(k, id);
      }
    }
    for (const id of ids) {
      cats[id].sentences = cats[id].sentences.filter((s) => owner.get(norm(s)) === id);
      out[id] = finish(cats[id], html);
      const sc = rawScore(html, id, Math.max(0, start - 200));
      if (sc !== null) out[id] = { ...(out[id] || { text: '', level: cats[id].level }), score: sc };
    }
  }
  if (!age && !out.violence && !out.sex && !out.language) return null;
  if (debug) out._region = region.slice(0, 2500);
  return out;
}
