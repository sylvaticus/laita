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

module.exports = { detectLanguage, paragraphs, paragraphAt, isProse };
