/**
 * The model answers with quoted substrings, not offsets. This module turns those quotes
 * back into exact [start, end) ranges inside the chunk, and throws away anything that
 * cannot be located, duplicates another issue, or overlaps a higher-priority one.
 */

const RANK = { error: 0, style: 1, rephrase: 2 };

export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function fingerprint(issue) {
  return hash(`${issue.type} ${issue.original} ${issue.replacement}`);
}

/** Typographic variants that should not stop us from finding a quote. */
const CHAR_FOLD = {
  "‘": "'", "’": "'", "‛": "'", "ʼ": "'",
  "“": '"', "”": '"', "„": '"', "«": '"', "»": '"',
  "–": "-", "—": "-", "−": "-"
};

/**
 * Fold typographic variants and collapse whitespace runs, keeping a map from each
 * character of the folded string back to its index in the source string.
 */
function fold(src) {
  let out = "";
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < src.length; i++) {
    const ch = CHAR_FOLD[src[i]] ?? src[i];
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out.length) {
      out += " ";
      map.push(i > 0 ? i - 1 : i);
    }
    pendingSpace = false;
    out += ch;
    map.push(i);
  }
  return { text: out, map };
}

/** All indices at which `needle` occurs in `hay`. */
function allIndices(hay, needle) {
  const out = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

/**
 * Candidate [start, end) ranges in `text` for the quoted `needle`, best strategy first.
 * Exact match wins; then a whitespace/quote-insensitive match; then case-insensitive.
 */
export function locate(text, needle) {
  const exact = allIndices(text, needle).map((i) => [i, i + needle.length]);
  if (exact.length) return exact;

  const f = fold(text);
  const n = fold(needle);
  if (!n.text) return [];

  const toRange = (i) => {
    const start = f.map[i];
    const last = f.map[i + n.text.length - 1];
    if (start === undefined || last === undefined) return null;
    return [start, last + 1];
  };

  const folded = allIndices(f.text, n.text).map(toRange).filter(Boolean);
  if (folded.length) return folded;

  return allIndices(f.text.toLowerCase(), n.text.toLowerCase()).map(toRange).filter(Boolean);
}

/**
 * @param {string} text       the chunk that was sent to the model
 * @param {Array}  rawIssues  whatever the model returned
 * @param {object} opts       { categories, ignored, offset }
 * @returns {Array} anchored issues, sorted by position, guaranteed non-overlapping
 */
export function anchorIssues(text, rawIssues, opts = {}) {
  const categories = opts.categories || { error: true, style: true, rephrase: true };
  const ignored = opts.ignored instanceof Set ? opts.ignored : new Set(opts.ignored || []);
  const offset = opts.offset || 0;
  const trimmedLen = text.trim().length;

  const candidates = [];
  const seen = new Set();

  for (const raw of rawIssues || []) {
    if (!raw || typeof raw !== "object") continue;

    const type = String(raw.type || "").toLowerCase();
    if (!(type in RANK) || !categories[type]) continue;

    const original = String(raw.original ?? "").trim();
    const replacement = String(raw.replacement ?? "").trim();
    const message = String(raw.message ?? "").trim();

    if (!original || original === replacement) continue;
    // A suggestion that restates the entire chunk is a rewrite, not a correction.
    if (trimmedLen > 120 && original.length >= trimmedLen * 0.95) continue;

    const fp = fingerprint({ type, original, replacement });
    if (ignored.has(fp)) continue;

    const key = `${type} ${original} ${replacement}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const ranges = locate(text, original);
    if (!ranges.length) continue;

    candidates.push({ type, original, replacement, message, fp, ranges, rank: RANK[type] });
  }

  // Higher-priority and longer spans claim their territory first.
  candidates.sort((a, b) => a.rank - b.rank || b.original.length - a.original.length);

  const accepted = [];
  const overlaps = (s, e) => accepted.some((x) => s < x.end && e > x.start);

  for (const c of candidates) {
    const free = c.ranges.find(([s, e]) => !overlaps(s, e));
    if (!free) continue;
    accepted.push({
      start: free[0] + offset,
      end: free[1] + offset,
      // Store what actually sits in the document, not what the model claimed to quote.
      original: text.slice(free[0], free[1]),
      replacement: c.replacement,
      type: c.type,
      message: c.message,
      fp: c.fp
    });
  }

  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}
