/**
 * "LAITA transform…": rewrite the selected text with a free-form instruction.
 *
 * Separate from proofreading in every way that matters. Proofreading is automatic, returns
 * a list of small anchored spans, and never rewrites wholesale. A transform is explicitly
 * asked for, applies to exactly the fragment the user selected, and replaces it in one go.
 *
 * The selection is captured as text offsets *before* the panel opens, because focusing the
 * panel's input blurs the field. Offsets survive that; a live DOM Range does not.
 */

/** Distinct from the proofreading colours, so the panel is never mistaken for a suggestion. */
const ACCENT = "#7c3aed";
const HINT = "Enter to run · Esc to cancel · ↑ ↓ for recent";

/** @type {null | {adapter, owned, start, end, selected, rect, instruction, reqId, output}} */
let state = null;
/** The panel element the listeners below are attached to. `Overlay.ensure()` builds a new
 *  one whenever the page wipes the host, and the new one needs them too. */
let wiredPanel = null;

// ---------------------------------------------------------------- small DOM helpers

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, cls, onClick) {
  const b = el("button", "act" + (cls ? " " + cls : ""), label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function panel() {
  LAITA.Overlay.ensure();
  const p = LAITA.Overlay.panel;
  if (wiredPanel !== p) {
    wiredPanel = p;
    // Keystrokes typed into our input must not reach the page: sites bind single-letter
    // shortcuts, and a closed shadow root still lets events bubble out retargeted.
    for (const type of ["keydown", "keyup", "keypress"]) {
      p.addEventListener(type, (e) => e.stopPropagation());
    }
    p.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
  }
  return p;
}

function head(subtitle) {
  const h = el("div", "head");
  h.append(el("span", "badge", "Transform"), el("span", "what", subtitle || ""), el("div", "spacer"));
  const x = el("button", "x", "×");
  x.type = "button";
  x.title = "Close";
  x.addEventListener("click", () => close());
  h.appendChild(x);
  return h;
}

function show(p) {
  p.style.setProperty("--c", ACCENT);
  p.classList.add("on");
  LAITA.placeNear(p, state.rect);
}

// ---------------------------------------------------------------- capturing the selection

/**
 * Reuse the adapter main.js is already driving when it is the same field, so we do not
 * build a second layout mirror for it. Anything we build ourselves is ours to destroy.
 */
function adapterAt(node) {
  if (!node) return null;
  const host = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const made = host && LAITA.adapterFor(host);
  if (!made) return null;
  const live = LAITA.getAdapter?.();
  if (live && live.isAlive() && live.el === made.el) {
    made.destroy();
    return { adapter: live, owned: false };
  }
  return { adapter: made, owned: true };
}

function acquire() {
  const consider = (node) => {
    const t = adapterAt(node);
    if (!t) return null;
    const range = t.adapter.selection();
    if (range) return { ...t, ...range };
    if (t.owned) t.adapter.destroy();
    return null;
  };

  // The focused field comes first: a selection inside <textarea>/<input> does not appear
  // in window.getSelection() at all.
  const focused = consider(document.activeElement);
  if (focused) return focused;

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const domRange = sel.getRangeAt(0);

  const inRange = consider(domRange.commonAncestorContainer);
  if (inRange) return inRange;

  // Ordinary page text: still worth transforming, but there is nothing to replace.
  const text = sel.toString();
  if (!text.trim()) return null;
  return { adapter: null, owned: false, text, domRange };
}

function anchorRect(t) {
  if (t.adapter) {
    const rects = t.adapter.rects(t.start, t.end);
    // The last rect: the panel then opens below the end of the selection, not its start.
    if (rects.length) return rects[rects.length - 1];
  }
  if (t.domRange) {
    const b = t.domRange.getBoundingClientRect();
    if (b.width || b.height) return { left: b.left, top: b.top, width: b.width, height: b.height };
  }
  return { left: Math.max(8, innerWidth / 2 - 230), top: innerHeight / 3, width: 0, height: 0 };
}

// ---------------------------------------------------------------- the three panel states

function renderAsk() {
  const p = panel();
  p.replaceChildren();

  const body = el("div", "body");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "ask";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = `What should I do with it?  (empty = ${defaultInstruction()})`;
  body.appendChild(input);

  let histIndex = -1;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run(input.value.trim() || defaultInstruction());
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const hist = LAITA.settings?.transformHistory || [];
      if (!hist.length) return;
      e.preventDefault();
      histIndex = LAITA.clamp(histIndex + (e.key === "ArrowUp" ? 1 : -1), -1, hist.length - 1);
      input.value = histIndex < 0 ? "" : hist[histIndex];
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  p.append(head(preview(state.selected)), body, el("div", "hint", HINT));
  show(p);
  input.focus();
}

/**
 * A rewrite emits about as much text as it consumes, so a long selection takes minutes,
 * not seconds. Saying so beats a bare spinner that looks indistinguishable from a hang -
 * measured on one machine, a paragraph took 4 seconds and ten pages took over three
 * minutes.
 */
function busyHint(chars) {
  if (chars < 1500) return null;
  const minutes = Math.max(1, Math.round(chars / 4 / 10 / 60));   // ~10 tokens/s on a long answer
  return `A selection this long takes a few minutes — roughly ${minutes} ` +
         `${minutes === 1 ? "minute" : "minutes"} on a typical GPU. Cancel is safe.`;
}

function renderBusy() {
  const p = panel();
  p.replaceChildren();
  const spinner = el("div", "spinner");
  const busy = el("div", "busy");
  busy.append(spinner, document.createTextNode("Transforming…"));
  const body = el("div", "body");
  body.appendChild(busy);
  const actions = el("div", "actions");
  actions.appendChild(button("Cancel", "", () => close()));
  const hint = busyHint(state.selected.length);
  p.append(head(state.instruction), body, actions);
  if (hint) p.appendChild(el("div", "hint", hint));
  show(p);
}

function renderResult() {
  const p = panel();
  p.replaceChildren();

  const body = el("div", "body");
  if (state.output !== state.selected) body.appendChild(el("div", "was", state.selected));
  body.appendChild(el("div", "out", state.output));

  const actions = el("div", "actions");
  let focusMe;
  if (state.adapter) {
    focusMe = button("Accept & replace", "primary", () => accept("replace"));
    actions.append(
      focusMe,
      button("Reject", "", () => close()),
      button("Accept & append", "", () => accept("append"))
    );
    p.append(head(state.instruction), body, actions);
  } else {
    focusMe = button("Copy", "primary", copyOutput);
    actions.append(focusMe, button("Close", "", () => close()));
    p.append(
      head(state.instruction),
      body,
      actions,
      el("div", "hint", "This selection is not in an editable field, so it cannot be replaced.")
    );
  }
  show(p);
  focusMe.focus();
}

function renderError(message, { canCopy = false } = {}) {
  const p = panel();
  p.replaceChildren();
  const actions = el("div", "actions");
  if (canCopy && state?.output) actions.appendChild(button("Copy the result", "primary", copyOutput));
  actions.appendChild(button("Close", canCopy ? "" : "primary", () => close()));
  p.append(head(state?.instruction || ""), el("div", "errbox", message), actions);
  show(p);
}

// ---------------------------------------------------------------- running and applying

function defaultInstruction() {
  return (LAITA.settings?.transformDefault || "polish").trim() || "polish";
}

function preview(text) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 60 ? one.slice(0, 59) + "…" : one;
}

async function run(instruction) {
  state.instruction = instruction;
  const reqId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  state.reqId = reqId;
  renderBusy();

  const lang =
    LAITA.settings.language === "auto"
      ? await LAITA.detectLanguage(state.selected)
      : LAITA.settings.language;
  if (state?.reqId !== reqId) return;

  const res = await LAITA.send({
    cmd: "transformText",
    text: state.selected,
    instruction,
    lang,
    reqId
  });
  if (state?.reqId !== reqId) return;

  state.reqId = null;
  if (!res?.ok) {
    renderError(res?.error || LAITA.sendFailure());
    return;
  }
  state.output = res.output;
  renderResult();
}

function accept(mode) {
  const st = state;
  if (!st?.adapter?.isAlive()) return close();

  st.adapter.invalidate();
  const text = st.adapter.getText();
  let { start, end } = st;

  if (text.slice(start, end) !== st.selected) {
    // The page moved the text while the model was working. Find the fragment again rather
    // than overwriting whatever now sits at those offsets.
    let idx = text.indexOf(st.selected, Math.max(0, start - 200));
    if (idx === -1) idx = text.indexOf(st.selected);
    if (idx === -1) {
      renderError("The text changed while the model was working, so nothing was replaced.", {
        canCopy: true
      });
      return;
    }
    start = idx;
    end = idx + st.selected.length;
  }

  if (mode === "append") {
    st.adapter.applyFix(end, end, LAITA.appendSeparator(st.selected, st.output) + st.output);
  } else {
    // The model is asked for the fragment, not for its surrounding whitespace; putting the
    // original's back keeps the words spaced the way they were.
    const lead = st.selected.match(/^\s*/)[0];
    const trail = st.selected.match(/\s*$/)[0];
    st.adapter.applyFix(start, end, lead + st.output.trim() + trail);
  }
  close();
}

async function copyOutput() {
  const text = state?.output || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard permission is not granted everywhere; the old path always works from a
    // click handler.
    const ta = document.createElement("textarea");
    ta.setAttribute("data-laita", "off");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* nothing more we can do */
    }
    ta.remove();
  }
  close();
}

/** `refocus` is off when a second invocation is replacing the first: handing focus back to
 *  the old field would make the new selection impossible to find. */
function close({ refocus = true } = {}) {
  const st = state;
  state = null;
  if (st?.reqId) LAITA.send({ cmd: "cancelTransform", reqId: st.reqId });
  const p = LAITA.Overlay.panel;
  if (p) {
    p.classList.remove("on");
    p.replaceChildren();
  }
  if (refocus && st?.adapter?.isAlive()) st.adapter.el.focus({ preventScroll: true });
  if (st?.owned) st.adapter?.destroy();
}

// ---------------------------------------------------------------- entry point

LAITA.Transform = {
  isOpen() {
    return !!state;
  },

  /** Called from main.js for both the context menu and Alt+Shift+T. */
  async open() {
    // A transform can be asked for before the page has finished booting - the menu item
    // and the hotkey are live immediately - so fetch the settings rather than doing
    // nothing at all, which is indistinguishable from the feature being broken.
    if (!LAITA.settings) {
      const res = await LAITA.send({ cmd: "getConfigFor", hostname: location.hostname });
      if (res?.settings) {
        LAITA.settings = res.settings;
        LAITA.active = res.active;
      }
    }
    if (!LAITA.settings) return { ok: false, reason: "not-ready" };
    close({ refocus: false });

    const t = acquire();
    if (!t) return { ok: false, reason: "no-selection" };

    const selected = t.adapter ? t.adapter.getText().slice(t.start, t.end) : t.text;
    if (!selected.trim()) {
      if (t.owned) t.adapter?.destroy();
      return { ok: false, reason: "no-selection" };
    }

    state = { ...t, selected, rect: anchorRect(t), instruction: "", reqId: null, output: "" };

    if (selected.length > LAITA.settings.maxChars) {
      renderError(
        `That selection is ${selected.length} characters, over the ${LAITA.settings.maxChars} limit ` +
          `set in the options.`
      );
      return { ok: true };
    }

    renderAsk();
    return { ok: true };
  },

  close,

  /** Keep the panel glued to the selection when the page scrolls or resizes. */
  reposition() {
    if (!state) return;
    const p = LAITA.Overlay.panel;
    if (!p?.classList.contains("on")) return;
    if (state.adapter?.isAlive()) {
      state.adapter.invalidate();
      const rects = state.adapter.rects(state.start, state.end);
      if (rects.length) state.rect = rects[rects.length - 1];
    } else if (state.domRange) {
      const b = state.domRange.getBoundingClientRect();
      if (b.width || b.height) state.rect = { left: b.left, top: b.top, width: b.width, height: b.height };
    }
    LAITA.placeNear(p, state.rect);
  }
};
