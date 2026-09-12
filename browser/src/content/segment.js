/**
 * Splitting a field into chunks that are worth one model call each.
 *
 * A paragraph is the natural unit: it gives the model enough context without wasting
 * tokens. Paragraphs longer than the limit are broken on sentence boundaries so that a
 * single long block of text still gets checked incrementally and cached per piece.
 */

/** Group the lines of `text` into paragraphs, preserving absolute offsets. */
function paragraphs(text) {
  const out = [];
  const re = /[^\n]*\n?/g;
  let current = null;
  let match;
  while ((match = re.exec(text)) !== null) {
    const line = match[0];
    if (line === "") break;
    const start = match.index;
    if (line.trim() === "") {
      current = null;
      continue;
    }
    if (current) {
      current.end = start + line.length;
    } else {
      current = { start, end: start + line.length };
      out.push(current);
    }
  }
  return out.map((p) => ({ start: p.start, text: text.slice(p.start, p.end) }));
}

/** Sentence boundaries via Intl.Segmenter, with a regex fallback. */
function sentences(text, lang) {
  try {
    const seg = new Intl.Segmenter(lang || "en", { granularity: "sentence" });
    return [...seg.segment(text)].map((s) => ({ start: s.index, text: s.segment }));
  } catch {
    const out = [];
    const re = /[^.!?…]*[.!?…]+[\s"'”»)]*|[^.!?…]+$/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) break;
      out.push({ start: m.index, text: m[0] });
    }
    return out;
  }
}

/**
 * @returns {Array<{start:number, text:string}>} chunks with trailing/leading blank space
 *          trimmed away but absolute offsets preserved.
 */
LAITA.chunkText = function (text, maxChars, lang) {
  const limit = Math.max(120, maxChars || 700);
  const chunks = [];

  const push = (start, body) => {
    const lead = body.length - body.trimStart().length;
    const trimmed = body.trim();
    if (trimmed.length >= 2) chunks.push({ start: start + lead, text: trimmed });
  };

  for (const para of paragraphs(text)) {
    if (para.text.trim().length <= limit) {
      push(para.start, para.text);
      continue;
    }
    // Too long: pack whole sentences until the limit would be exceeded.
    let bufStart = null;
    let buf = "";
    const flush = () => {
      if (buf) push(bufStart, buf);
      buf = "";
      bufStart = null;
    };
    for (const s of sentences(para.text, lang)) {
      const absStart = para.start + s.start;
      if (buf && buf.length + s.text.length > limit) flush();
      if (!buf) bufStart = absStart;
      buf += s.text;
      // A single sentence longer than the limit goes out on its own.
      if (buf.length >= limit) flush();
    }
    flush();
  }
  return chunks;
};

/**
 * Which chunk holds the caret, or -1 when there is no caret to work from.
 *
 * A caret exactly on a boundary belongs to the chunk that ends there, so typing at the
 * end of a paragraph re-checks the paragraph being typed. A caret that lands between
 * chunks - a blank line, the gap the paragraph splitter skipped - falls back to the
 * nearest one before it, because clicking into the space above a paragraph should not
 * be a dead zone where nothing is ever checked.
 */
LAITA.chunkAtCaret = function (chunks, caret) {
  if (caret == null || caret < 0 || !chunks.length) return -1;
  let before = -1;
  for (let i = 0; i < chunks.length; i++) {
    const start = chunks[i].start;
    if (caret >= start && caret <= start + chunks[i].text.length) return i;
    if (start <= caret) before = i;
  }
  return before === -1 ? 0 : before;
};
