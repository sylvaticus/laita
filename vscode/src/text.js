/**
 * Text handling for the VS Code surface.
 *
 * The browser extension works in character offsets because that is what a DOM Range and
 * a textarea's selection speak. VS Code speaks (line, character), so paragraphs are
 * found by line here rather than by reusing the browser's offset-based chunker - the
 * conversion in both directions would cost more than the duplication saves.
 *
 * Pure: no `vscode` import, so it is testable under plain node.
 */

/** Words that are cheap and reliable markers of a language, for short texts. */
const STOPWORDS = {
  en: "the of and to in is that it for you with was are this but not have from they will would there their which about",
  fr: "le la les de des du et est un une que qui pour dans pas vous nous je ne sur avec plus sont cette mais tout comme être ont votre",
  it: "il lo la le gli di che e un una per non con sono come anche piu questo della nel alla ma se ho hanno essere",
  es: "el la los las de que y un una por para no con su se lo como mas pero este esta son tiene hay muy",
  de: "der die das und ist ein eine nicht mit den von zu sich auf fur im dem auch aber wird sind haben kann werden",
  pt: "de que nao um uma para com por os as do da em mais como mas seu sua estão foi ser tem",
  nl: "de het een en van is dat in te niet op zijn met voor er maar aan die ook als wordt"
};

const STOPSETS = Object.fromEntries(
  Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(" "))])
);

/**
 * Guess the language from marker words. Deliberately simple: the browser extension can
 * fall back on Firefox's own detector, and there is no equivalent in Node.
 */
function detectLanguage(text) {
  const tokens = text.slice(0, 4000).toLowerCase().normalize("NFC")
    .split(/[^\p{L}\p{M}']+/u).filter(Boolean).slice(0, 400);
  let best = null, bestScore = 0, runnerUp = 0;
  for (const [lang, set] of Object.entries(STOPSETS)) {
    let n = 0;
    for (const t of tokens) if (set.has(t)) n++;
    if (n > bestScore) { runnerUp = bestScore; best = lang; bestScore = n; }
    else if (n > runnerUp) runnerUp = n;
  }
  return bestScore >= 2 && bestScore > runnerUp ? best : "en";
}

/**
 * Split lines into paragraphs, as [startLine, endLine] inclusive.
 *
 * A blank line separates paragraphs. Fenced code blocks are treated as one opaque
 * paragraph and marked, so a proofreader is never invited to "correct" code.
 */
function paragraphs(lines) {
  const out = [];
  let start = null, inFence = false;

  const close = (end) => {
    if (start !== null) out.push({ start, end, code: inFence });
    start = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence) { close(i - 1); inFence = true; start = i; }
      else { out.push({ start, end: i, code: true }); start = null; inFence = false; }
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "") close(i - 1);
    else if (start === null) start = i;
  }
  close(lines.length - 1);
  return out.filter((p) => p.start !== null && p.start <= p.end);
}

/** The paragraph containing `line`, or null. */
function paragraphAt(lines, line) {
  return paragraphs(lines).find((p) => line >= p.start && line <= p.end) || null;
}

/**
 * Something worth sending to a model: prose, long enough to be worth a round trip, and
 * not a code fence, a table, or a block of link definitions.
 */
function isProse(text, code) {
  if (code) return false;
  const t = text.trim();
  if (t.length < 12) return false;
  if (/^\s*\|/.test(t)) return false;                 // a markdown table
  if (!/[\p{L}]{3}/u.test(t)) return false;           // no real words
  const words = t.split(/\s+/).length;
  return words >= 3;
}

/** Sentences, as [{offset, text}] relative to `text`. Mirrors the browser's splitter. */
function sentences(text, lang) {
  try {
    const seg = new Intl.Segmenter(lang || "en", { granularity: "sentence" });
    return [...seg.segment(text)].map((s) => ({ offset: s.index, text: s.segment }));
  } catch {
    const out = [];
    const re = /[^.!?\u2026]*[.!?\u2026]+[\s"'\u201d\u00bb)]*|[^.!?\u2026]+$/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) break;
      out.push({ offset: m.index, text: m[0] });
    }
    return out;
  }
}

/**
 * Break a paragraph into pieces small enough to be worth one request.
 *
 * The model's latency grows faster than the text it is given: measured on one machine,
 * 419 characters took 4.4 seconds, 699 took 9.0, and 1119 took 19.4. Sending a whole
 * long paragraph is therefore much worse than sending the part being worked on, which
 * is why the browser extension has always chunked and why this now does too.
 *
 * Offsets are relative to `text`, so the caller adds the paragraph's own offset.
 */
function chunkParagraph(text, limit, lang) {
  const max = Math.max(120, limit || 700);
  if (text.length <= max) return [{ offset: 0, text }];

  const chunks = [];
  let buf = "";
  let start = null;
  const flush = () => {
    if (buf.trim()) chunks.push({ offset: start, text: buf });
    buf = "";
    start = null;
  };

  for (const s of sentences(text, lang)) {
    if (buf && buf.length + s.text.length > max) flush();
    if (start === null) start = s.offset;
    buf += s.text;
    if (buf.length >= max) flush();          // a single sentence longer than the limit
  }
  flush();
  return chunks.length ? chunks : [{ offset: 0, text }];
}

/** The chunk containing `offset`, or null. */
function chunkAt(chunks, offset) {
  return chunks.find((c) => offset >= c.offset && offset <= c.offset + c.text.length) || null;
}

module.exports = { detectLanguage, paragraphs, paragraphAt, isProse, chunkParagraph, chunkAt };
