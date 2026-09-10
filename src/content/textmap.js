/**
 * Field adapters.
 *
 * Two very different beasts have to look the same to the rest of the extension:
 *   - <textarea> / <input>, whose text has no DOM at all. Geometry is recovered by laying
 *     the same string out in a hidden "mirror" div that copies the field's typography.
 *   - contenteditable hosts, where the text is real DOM. Here we build a plain-text
 *     projection plus a map back to the text nodes it came from.
 *
 * Both expose: getText(), rects(start,end), clipRect(), applyFix(start,end,text), caretIn(),
 * selection().
 */

const SENSITIVE_TYPES = new Set([
  "password", "email", "url", "tel", "number", "date", "datetime-local",
  "month", "week", "time", "color", "range", "file", "hidden", "checkbox",
  "radio", "submit", "button", "image", "reset"
]);

const SENSITIVE_HINT = /pass|pwd|card|cvc|cvv|secret|token|otp|iban|ssn|credit|security|pin\b|totp|2fa|captcha/i;
const SENSITIVE_AUTOCOMPLETE = /password|cc-|one-time-code|username|email|tel|address|postal|country|name/i;

/** Typography that must be replicated exactly for the mirror to lay text out identically. */
const MIRROR_PROPS = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch",
  "fontKerning", "fontFeatureSettings", "fontVariationSettings", "letterSpacing",
  "wordSpacing", "lineHeight", "textTransform", "textIndent", "textAlign",
  "textRendering", "direction", "tabSize", "wordBreak", "hyphens"
];

function attrBlob(el) {
  return [
    el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("placeholder"),
    el.getAttribute("aria-label"), el.getAttribute("autocomplete"), el.className
  ].filter(Boolean).join(" ");
}

/** The visible box we are allowed to paint in: the field, cropped by scrolling ancestors. */
function scrollClipRect(el, base) {
  let rect = { left: base.left, top: base.top, right: base.right, bottom: base.bottom };
  let node = el.parentElement;
  while (node && node !== document.documentElement) {
    let cs;
    try {
      cs = getComputedStyle(node);
    } catch {
      break;
    }
    if (/(auto|scroll|hidden|clip)/.test(cs.overflowX + " " + cs.overflowY)) {
      const r = node.getBoundingClientRect();
      rect.left = Math.max(rect.left, r.left);
      rect.top = Math.max(rect.top, r.top);
      rect.right = Math.min(rect.right, r.right);
      rect.bottom = Math.min(rect.bottom, r.bottom);
    }
    node = node.parentElement;
  }
  return {
    left: rect.left,
    top: rect.top,
    width: Math.max(0, rect.right - rect.left),
    height: Math.max(0, rect.bottom - rect.top)
  };
}

class BaseAdapter {
  constructor(el) {
    this.el = el;
    this._dirty = true;
  }
  invalidate() {
    this._dirty = true;
  }
  isAlive() {
    return this.el.isConnected;
  }
  destroy() {}
}

// ------------------------------------------------------------------ <textarea> / <input>

class InputAdapter extends BaseAdapter {
  constructor(el) {
    super(el);
    this.kind = "input";
    this.multiline = el.tagName === "TEXTAREA";
  }

  getText() {
    return this.el.value ?? "";
  }

  caretIn() {
    try {
      return this.el.selectionStart;
    } catch {
      return null;
    }
  }

  /** The highlighted range as text offsets, or null when nothing is selected. */
  selection() {
    try {
      const { selectionStart: start, selectionEnd: end } = this.el;
      if (start == null || end == null || end <= start) return null;
      return { start, end };
    } catch {
      return null;                 // inputs that do not expose a selection
    }
  }

  /** Rebuild the hidden layout twin, but only when the text or the box actually changed. */
  _ensureMirror() {
    const el = this.el;
    const cs = getComputedStyle(el);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    const bordL = parseFloat(cs.borderLeftWidth) || 0;
    const bordT = parseFloat(cs.borderTopWidth) || 0;
    const contentW = Math.max(0, el.clientWidth - padL - padR);
    const text = this.getText();

    this.geom = { padL, padT, padB, bordL, bordT, contentW };

    const sig = [text.length, contentW, cs.fontSize, cs.fontFamily, cs.lineHeight, el.clientHeight].join("|");
    if (!this._dirty && this._sig === sig && this.mirror?.isConnected && this._text === text) return;

    if (!this.mirror) {
      this.mirror = document.createElement("div");
      this.mirror.setAttribute("data-locaispell-mirror", "");
      (document.body || document.documentElement).appendChild(this.mirror);
    }
    const s = this.mirror.style;
    s.cssText = "";
    for (const prop of MIRROR_PROPS) s[prop] = cs[prop];
    s.position = "absolute";
    s.top = "0";
    s.left = "-99999px";
    s.visibility = "hidden";
    s.pointerEvents = "none";
    s.boxSizing = "content-box";
    s.margin = "0";
    s.padding = "0";
    s.border = "0";
    s.height = "auto";
    s.overflow = "visible";
    s.width = contentW + "px";
    s.whiteSpace = this.multiline ? "pre-wrap" : "pre";
    s.overflowWrap = this.multiline ? (cs.overflowWrap === "normal" ? "break-word" : cs.overflowWrap) : "normal";
    // A single-line input centres its text vertically whatever the line-height says.
    if (!this.multiline) s.lineHeight = Math.max(1, el.clientHeight - padT - padB) + "px";

    // A trailing newline needs a character after it or the last line has no box.
    this.mirror.textContent = text + "\u200b";
    this._sig = sig;
    this._text = text;
    this._dirty = false;
  }

  rects(start, end) {
    this._ensureMirror();
    const node = this.mirror.firstChild;
    if (!node) return [];
    const len = node.length;
    const range = document.createRange();
    range.setStart(node, LAS.clamp(start, 0, len));
    range.setEnd(node, LAS.clamp(end, 0, len));

    const el = this.el;
    const mRect = this.mirror.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const { padL, padT, bordL, bordT } = this.geom;
    const ox = eRect.left + bordL + padL - el.scrollLeft - mRect.left;
    const oy = eRect.top + bordT + padT - el.scrollTop - mRect.top;

    return [...range.getClientRects()]
      .filter((r) => r.width > 0.5 && r.height > 0.5)
      .map((r) => ({ left: r.left + ox, top: r.top + oy, width: r.width, height: r.height }));
  }

  clipRect() {
    const el = this.el;
    const cs = getComputedStyle(el);
    const bordL = parseFloat(cs.borderLeftWidth) || 0;
    const bordT = parseFloat(cs.borderTopWidth) || 0;
    const r = el.getBoundingClientRect();
    const box = {
      left: r.left + bordL,
      top: r.top + bordT,
      right: r.left + bordL + el.clientWidth,
      bottom: r.top + bordT + el.clientHeight
    };
    return scrollClipRect(el, box);
  }

  applyFix(start, end, replacement) {
    const el = this.el;
    const text = this.getText();
    el.focus({ preventScroll: true });
    try {
      el.setSelectionRange(start, end);
      // execCommand keeps the native undo stack and fires the events frameworks expect.
      if (document.execCommand("insertText", false, replacement)) {
        this.invalidate();
        return true;
      }
    } catch {
      /* fall through to the manual path below */
    }
    const proto = this.multiline ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const next = text.slice(0, start) + replacement + text.slice(end);
    if (setter) setter.call(el, next);
    else el.value = next;
    try {
      el.setSelectionRange(start + replacement.length, start + replacement.length);
    } catch {
      /* inputs that do not support selection */
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    this.invalidate();
    return true;
  }

  destroy() {
    this.mirror?.remove();
    this.mirror = null;
  }
}

// ------------------------------------------------------------------ contenteditable

class EditableAdapter extends BaseAdapter {
  constructor(el) {
    super(el);
    this.kind = "contenteditable";
  }

  /** Project the subtree to plain text, remembering where every run came from. */
  _build() {
    if (!this._dirty && this._parts) return;
    const parts = [];
    let text = "";

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const data = node.data;
        if (data) {
          parts.push({ node, textStart: text.length, len: data.length });
          text += data;
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") return;
      if (tag === "BR") {
        text += "\n";
        return;
      }
      let cs = null;
      try {
        cs = getComputedStyle(node);
      } catch {
        /* detached */
      }
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) return;
      const display = cs ? cs.display : "block";
      const isBlock = display !== "contents" && !display.startsWith("inline");
      if (isBlock && text && !text.endsWith("\n")) text += "\n";
      for (const child of node.childNodes) walk(child);
      if (isBlock && text && !text.endsWith("\n")) text += "\n";
    };

    for (const child of this.el.childNodes) walk(child);

    this._parts = parts;
    this._text = text.replace(/\n+$/, "");
    this._dirty = false;
  }

  getText() {
    this._build();
    return this._text;
  }

  caretIn() {
    const sel = window.getSelection();
    if (!sel || !sel.focusNode || !this.el.contains(sel.focusNode)) return null;
    this._build();
    const part = this._parts.find((p) => p.node === sel.focusNode);
    return part ? part.textStart + sel.focusOffset : null;
  }

  /**
   * (text node, offset within it) -> text offset. The inverse of `_point`.
   * A boundary that is not in a mapped run - an element boundary, or a node the
   * projection skipped - collapses to the start of the next run, the same way `_point`
   * clamps a synthetic newline to the nearest real position.
   */
  _offsetOf(node, offset) {
    this._build();
    const parts = this._parts;
    if (!parts.length) return null;

    if (node.nodeType === Node.TEXT_NODE) {
      const part = parts.find((p) => p.node === node);
      if (part) return part.textStart + LAS.clamp(offset, 0, part.len);
    }

    let probe;
    try {
      probe = document.createRange();
      probe.setStart(node, offset);
      probe.collapse(true);
    } catch {
      return null;
    }
    for (const p of parts) {
      const r = document.createRange();
      r.setStart(p.node, 0);
      r.setEnd(p.node, p.len);
      if (probe.compareBoundaryPoints(Range.START_TO_START, r) <= 0) return p.textStart;
    }
    const last = parts[parts.length - 1];
    return last.textStart + last.len;
  }

  selection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.el.contains(range.commonAncestorContainer)) return null;
    const start = this._offsetOf(range.startContainer, range.startOffset);
    const end = this._offsetOf(range.endContainer, range.endOffset);
    if (start == null || end == null || end <= start) return null;
    return { start, end };
  }

  /** Text offset -> (text node, offset within it). */
  _point(offset) {
    this._build();
    const parts = this._parts;
    if (!parts.length) return null;
    let lo = 0;
    let hi = parts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = parts[mid];
      if (offset < p.textStart) hi = mid - 1;
      else if (offset > p.textStart + p.len) lo = mid + 1;
      else return { node: p.node, offset: offset - p.textStart };
    }
    // Landed on a synthetic newline: clamp to the closest real position.
    const after = parts.find((p) => p.textStart >= offset);
    if (after) return { node: after.node, offset: 0 };
    const last = parts[parts.length - 1];
    return { node: last.node, offset: last.len };
  }

  _range(start, end) {
    const a = this._point(start);
    const b = this._point(end);
    if (!a || !b) return null;
    try {
      const range = document.createRange();
      range.setStart(a.node, LAS.clamp(a.offset, 0, a.node.length));
      range.setEnd(b.node, LAS.clamp(b.offset, 0, b.node.length));
      if (range.collapsed && start !== end) return null;
      return range;
    } catch {
      return null;
    }
  }

  rects(start, end) {
    const range = this._range(start, end);
    if (!range) return [];
    return [...range.getClientRects()]
      .filter((r) => r.width > 0.5 && r.height > 0.5)
      .map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
  }

  clipRect() {
    const r = this.el.getBoundingClientRect();
    return scrollClipRect(this.el, { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }

  applyFix(start, end, replacement) {
    this.invalidate();
    const range = this._range(start, end);
    if (!range) return false;
    const el = this.el;
    el.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let done = false;
    try {
      done = document.execCommand("insertText", false, replacement);
    } catch {
      /* fall through */
    }
    if (!done) {
      range.deleteContents();
      const textNode = document.createTextNode(replacement);
      range.insertNode(textNode);
      const after = document.createRange();
      after.setStartAfter(textNode);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertReplacementText",
          data: replacement
        })
      );
    }
    this.invalidate();
    return true;
  }
}

// ------------------------------------------------------------------ detection

/** Should Local AI Spell Checker ever look at this element? */
LAS.isCheckable = function (el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (el.closest("[data-locaispell='off']")) return false;
  if (el.isContentEditable) {
    if (el.getAttribute("aria-hidden") === "true") return false;
    return true;
  }
  const tag = el.tagName;
  if (tag !== "TEXTAREA" && tag !== "INPUT") return false;
  if (el.disabled || el.readOnly) return false;
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (SENSITIVE_TYPES.has(type)) return false;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (ac && ac !== "off" && SENSITIVE_AUTOCOMPLETE.test(ac)) return false;
  }
  if (SENSITIVE_HINT.test(attrBlob(el))) return false;
  return true;
};

/** Build the right adapter for a focused element, or null. */
LAS.adapterFor = function (el) {
  if (!LAS.isCheckable(el)) return null;
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return new InputAdapter(el);
  const host = el.closest(
    "[contenteditable=''],[contenteditable='true'],[contenteditable='plaintext-only']"
  );
  if (!host || !LAS.isCheckable(host)) return null;
  return new EditableAdapter(host);
};
