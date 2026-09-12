/**
 * Shared state and helpers for the content scripts.
 * All content scripts of an extension share one sandbox global, so `var LAITA` declared here
 * is visible to the files listed after this one in the manifest.
 */

// Chrome exposes only `chrome`; its MV3 APIs return promises, so aliasing is enough.
// Content scripts are classic scripts and cannot import, hence the duplicate of the
// first line of common/compat.js.
globalThis.browser ??= globalThis.chrome;

var LAITA = {
  clientId: Math.random().toString(36).slice(2) + Date.now().toString(36),
  settings: null,
  active: false
};

/** Failures that mean "nobody was listening", rather than "the handler said no". */
const NO_RECEIVER =
  /Receiving end does not exist|Could not establish connection|Message manager disconnected|Extension context invalidated|dead object/i;

/**
 * Has this content script outlived the extension that injected it?
 *
 * Reloading the extension - in about:debugging, or on an update - leaves the scripts
 * already running in open tabs attached to an extension context that no longer exists.
 * They look alive but can never reach a background page again, and the only cure is
 * reloading the page.
 */
LAITA.isOrphaned = function () {
  try {
    return !browser.runtime?.id;
  } catch {
    return true;                 // the whole `browser` object died with its context
  }
};

/**
 * Why a message could not be delivered: "orphaned" is terminal, "starting" is worth one
 * more try, anything else is a real failure in the handler.
 */
LAITA.sendFailureKind = function (message, orphaned) {
  if (orphaned) return "orphaned";
  return NO_RECEIVER.test(String(message)) ? "starting" : "other";
};

/**
 * null means the message never reached the background page - a different failure from
 * anything Ollama might say, so the reason is kept for the message shown to the user.
 *
 * The background is an event page, so it may be asleep when a message arrives. Firefox
 * normally wakes it, but a message landing in the middle of that can still be refused,
 * and a single short retry covers it. An orphaned script is not retried: it will never
 * succeed, and waiting only delays telling the user to reload the page.
 */
LAITA.sendFailure = function () {
  return LAITA.isOrphaned()
    ? "Local AI Text Assistant was reloaded or updated, so this page is still running the old copy. " +
      "Reload the page to reconnect it."
    : "Local AI Text Assistant's background page did not answer" +
      (LAITA.lastSendError ? ` (${LAITA.lastSendError})` : "") +
      ". Reload the page and try again.";
};

LAITA.send = async function (msg) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await browser.runtime.sendMessage(msg);
    } catch (err) {
      LAITA.lastSendError = String(err?.message || err);
      const kind = LAITA.sendFailureKind(LAITA.lastSendError, LAITA.isOrphaned());
      if (attempt > 0 || kind !== "starting") return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
};

LAITA.log = (...args) => {
  if (LAITA.settings?.debug) console.log("%c[laita]", "color:#3b82f6", ...args);
};

LAITA.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Place a fixed-position box just under `rect`, flipping above it when there is no room
 * below and clamping to the viewport either way.
 */
LAITA.placeNear = function (node, rect) {
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const gap = 6;
  const left = LAITA.clamp(rect.left, 8, Math.max(8, innerWidth - w - 8));
  let top = rect.top + rect.height + gap;
  if (top + h > innerHeight - 8) {
    const above = rect.top - h - gap;
    top = above >= 8 ? above : LAITA.clamp(innerHeight - h - 8, 8, innerHeight);
  }
  node.style.left = left + "px";
  node.style.top = top + "px";
};

/**
 * Where to put the status pill, given the field's visible box.
 *
 * It used to sit inside the bottom-right corner, where it covered the very words being
 * typed. It now goes just outside the field - below it by preference, above it when the
 * field runs to the bottom of the window - and only falls back inside when the field is
 * taller than the viewport and there is nowhere else to go.
 */
LAITA.pillPosition = function (rect, size, view) {
  const gap = 4;
  const left = LAITA.clamp(rect.left + rect.width - size.width - gap, gap, Math.max(gap, view.width - size.width - gap));

  const below = rect.top + rect.height + gap;
  if (below + size.height <= view.height - gap) return { left, top: below, where: "below" };

  const above = rect.top - size.height - gap;
  if (above >= gap) return { left, top: above, where: "above" };

  return {
    left,
    top: LAITA.clamp(rect.top + rect.height - size.height - gap, gap, Math.max(gap, view.height - size.height - gap)),
    where: "inside"
  };
};

/**
 * What to put between a fragment and something appended right after it.
 * Nothing when either side already carries the whitespace; a blank line when either side
 * spans more than one line, because a space would silently join two blocks.
 */
LAITA.appendSeparator = function (selected, addition) {
  if (!addition) return "";
  if (/\s$/.test(selected) || /^\s/.test(addition)) return "";
  return /\n/.test(selected) || /\n/.test(addition) ? "\n\n" : " ";
};

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

/** Count how many tokens of the text belong to each language's marker list. */
function stopwordScores(text) {
  const tokens = text
    .toLowerCase()
    .normalize("NFC")
    .split(/[^\p{L}\p{M}']+/u)
    .filter(Boolean)
    .slice(0, 400);
  const scores = {};
  for (const [lang, set] of Object.entries(STOPSETS)) {
    let n = 0;
    for (const t of tokens) if (set.has(t)) n++;
    scores[lang] = n;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return { top: ranked[0], runnerUp: ranked[1], tokens: tokens.length };
}

/**
 * Detect the language of a field.
 * Firefox's built-in detector is good on long text and erratic on short text, so on short
 * text the stopword heuristic wins, and on long text it is only used as a tie-breaker.
 */
LAITA.detectLanguage = async function (text) {
  const sample = text.slice(0, 4000);
  const heur = stopwordScores(sample);
  const heurLang = heur.top?.[1] >= 2 && heur.top[1] > (heur.runnerUp?.[1] ?? 0) ? heur.top[0] : null;

  let cldLang = null;
  let cldReliable = false;
  try {
    const res = await browser.i18n.detectLanguage(sample);
    const best = res?.languages?.[0];
    if (best) {
      cldLang = best.language.split("-")[0];
      cldReliable = !!res.isReliable && best.percentage >= 60;
    }
  } catch {
    /* detector unavailable */
  }

  if (cldLang && cldLang === heurLang) return cldLang;
  if (sample.length < 200) return heurLang || cldLang || "en";
  if (cldReliable) return cldLang;
  return heurLang || cldLang || "en";
};

/**
 * Keep issues aligned with text that may have changed while the model was thinking.
 * An issue whose span no longer holds its original text is searched for nearby and
 * shifted; if it cannot be found it is dropped.
 */
LAITA.reconcile = function (issues, text) {
  const out = [];
  for (const issue of issues) {
    if (text.slice(issue.start, issue.end) === issue.original) {
      out.push(issue);
      continue;
    }
    const from = Math.max(0, issue.start - 200);
    const idx = text.indexOf(issue.original, from);
    if (idx !== -1 && idx < issue.start + 200) {
      out.push({ ...issue, start: idx, end: idx + issue.original.length });
    }
  }
  // Drop overlaps that shifting may have created, keeping the earliest.
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const i of out) {
    if (kept.length && i.start < kept[kept.length - 1].end) continue;
    kept.push(i);
  }
  return kept;
};

/** Issues that fall entirely outside [from, to): what a scoped re-check must not discard. */
LAITA.issuesOutside = function (issues, from, to) {
  return issues.filter((i) => i.end <= from || i.start >= to);
};

LAITA.WORST = (issues) => {
  if (issues.some((i) => i.type === "error")) return "error";
  if (issues.some((i) => i.type === "style")) return "style";
  if (issues.length) return "rephrase";
  return "none";
};
