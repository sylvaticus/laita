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
function fold(src, lower = false) {
  let out = "";
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < src.length; i++) {
    let ch = CHAR_FOLD[src[i]] ?? src[i];
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out.length) {
      out += " ";
      map.push(i > 0 ? i - 1 : i);
    }
    pendingSpace = false;
    // Case folding is NOT length-preserving: "\u0130".toLowerCase() is two code units. So one
    // source character can contribute several folded ones, and `map` needs an entry for
    // each of them or every index after it is wrong.
    if (lower) ch = ch.toLowerCase();
    out += ch;
    for (let k = 0; k < ch.length; k++) map.push(i);
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

  // Each pass folds both strings the same way and uses the map built by that same pass.
  // Lower-casing an already-folded string instead would shift every index past a character
  // whose lower case is longer than itself, and the widened span is then stored as the
  // issue's `original` - so every later "does this span still hold its original text?"
  // check compares the wrong text against itself and passes. That is precisely the class
  // of failure this module exists to prevent.
  const matches = (lower) => {
    const f = fold(text, lower);
    const n = fold(needle, lower);
    if (!n.text) return [];
    return allIndices(f.text, n.text)
      .map((i) => {
        const start = f.map[i];
        const last = f.map[i + n.text.length - 1];
        if (start === undefined || last === undefined) return null;
        return [start, last + 1];
      })
      .filter(Boolean);
  };

  const folded = matches(false);
  if (folded.length) return folded;

  return matches(true);
}

/**
 * @param {string} text       the chunk that was sent to the model
 * @param {Array}  rawIssues  whatever the model returned
 * @param {object} opts       { categories, ignored, offset }
 * @returns {Array} anchored issues, sorted by position, guaranteed non-overlapping
 */
/**
 * Has the model abbreviated its own replacement instead of writing it out?
 *
 * Asked to add a comma to a long sentence, it answered with the sentence's opening
 * followed by "..." - and applying that deleted the rest of the paragraph. The prompt
 * demands a drop-in replacement; when the answer is visibly not one, the only safe move
 * is to drop the suggestion, because applying it destroys text.
 *
 * Two signs. An ellipsis the original does not have is conclusive. Beyond that, a
 * replacement less than half the length of a long quote is elision rather than editing:
 * real corrections of that size do happen, but the prompt asks for quotes of a few
 * words, so a long one that comes back halved is far more likely to have been cut short.
 */
const ELLIPSIS = /(\.\s*\.\s*\.|\u2026)\s*$/;
const LONG_QUOTE = 60;

function looksTruncated(original, replacement) {
  if (ELLIPSIS.test(replacement) && !ELLIPSIS.test(original)) return true;
  return original.length >= LONG_QUOTE && replacement.length < original.length * 0.5;
}

/**
 * Would applying this replacement just duplicate what is already there?
 *
 * Models quote a substring that stops short of the character they want to add: asked
 * about "Sorry, I don't speak very well English." one reliably answers
 * original "English", replacement "English.", complaining of a missing full stop that is
 * already present. Applying that gives "English..".
 *
 * So when the replacement merely wraps the quote in extra characters, check whether the
 * document already has them on that side. If it does, the suggestion has nothing to fix.
 * This is the same defence as dropping a quote that cannot be found: never trust the
 * model's view of the text over the text.
 */
function alreadyThere(text, start, end, replacement) {
  const quoted = text.slice(start, end);
  const at = replacement.indexOf(quoted);
  if (at === -1) return false;                 // a real rewrite, not an insertion

  const before = replacement.slice(0, at);
  const after = replacement.slice(at + quoted.length);
  if (!before && !after) return false;         // identical, handled elsewhere

  const beforeIsThere = !before || text.slice(start - before.length, start) === before;
  const afterIsThere = !after || text.startsWith(after, end);
  return beforeIsThere && afterIsThere;
}

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
    if (looksTruncated(original, replacement)) continue;
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
  //
  // (see alreadyThere below, applied when a span is chosen)
  candidates.sort((a, b) => a.rank - b.rank || b.original.length - a.original.length);

  const accepted = [];
  const overlaps = (s, e) => accepted.some((x) => s < x.end && e > x.start);

  for (const c of candidates) {
    const free = c.ranges.find(([s, e]) => !overlaps(s, e) && !alreadyThere(text, s, e, c.replacement));
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
