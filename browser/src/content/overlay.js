/**
 * The visual layer.
 *
 * Everything Local AI Text Assistant draws lives in one shadow root attached to <html>, so page CSS can
 * neither restyle it nor be disturbed by it. The layer is pointer-events:none: clicks go
 * straight through to the field, and we work out which highlight was hit by testing the
 * click against the rectangles we drew. That keeps caret placement and text selection
 * behaving exactly as the page intended.
 */

const WAVE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3' viewBox='0 0 6 3'>" +
      "<path d='M0 2.2 Q1.5 0.2 3 2.2 T6 2.2' fill='none' stroke='#000' stroke-width='1.1'/></svg>"
  );

const CSS = `
:host { all: initial; }
.layer {
  position: fixed; inset: 0; pointer-events: none;
  z-index: 2147483646; contain: strict;
}
.clip { position: fixed; overflow: hidden; pointer-events: none; }
.deco {
  position: absolute; pointer-events: none; border-radius: 2px;
  transition: background-color .1s ease;
}
.deco.tint { background-color: color-mix(in srgb, var(--c) 13%, transparent); }
.deco.hot  { background-color: color-mix(in srgb, var(--c) 26%, transparent); }
.deco::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 3px;
  background-color: var(--c);
  mask-image: url("${WAVE}"); mask-repeat: repeat-x; mask-size: 6px 3px;
  -webkit-mask-image: url("${WAVE}"); -webkit-mask-repeat: repeat-x; -webkit-mask-size: 6px 3px;
}

/*
 * The pill is deliberately see-through and click-through: it is a status readout, not a
 * control, and it used to hide the words being typed. Only its close button takes clicks,
 * so text under the rest of it stays selectable.
 */
.pill {
  position: fixed; pointer-events: none; display: none; align-items: center; gap: 6px;
  font: 500 11px/1.4 system-ui, sans-serif; color: #e5e7eb;
  background: rgba(31,41,55,.62); border-radius: 999px; padding: 3px 4px 3px 9px;
  box-shadow: 0 1px 3px rgba(0,0,0,.18); white-space: nowrap;
  opacity: .8; transition: opacity .12s ease;
}
.pill.on { display: inline-flex; }
.pill.err { background: rgba(153,27,27,.72); }
.pill.inside { opacity: .55; }
.pill .pillx {
  pointer-events: auto; cursor: pointer; border: 0; background: none; padding: 0 3px;
  color: inherit; font: 600 12px/1 system-ui, sans-serif; opacity: .75; border-radius: 999px;
}
.pill .pillx:hover { opacity: 1; background: rgba(255,255,255,.18); }
.spinner {
  width: 8px; height: 8px; border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,.35); border-top-color: #fff;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.card, .panel {
  position: fixed; display: none; pointer-events: auto;
  width: max-content; max-width: min(380px, calc(100vw - 24px));
  background: #ffffff; color: #111827;
  border: 1px solid #d1d5db; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18);
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  overflow: hidden;
}
.card.on, .panel.on { display: block; }
.panel { width: min(460px, calc(100vw - 24px)); max-width: min(460px, calc(100vw - 24px)); }
.head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid #f0f1f3; background: #fafafa;
}
.badge {
  font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
  color: #fff; background: var(--c); border-radius: 4px; padding: 2px 6px;
}
.lang { font-size: 10px; color: #9ca3af; text-transform: uppercase; letter-spacing: .05em; }
.what {
  font-size: 11px; color: #9ca3af; max-width: 230px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.spacer { flex: 1; }
.x {
  border: 0; background: none; cursor: pointer; color: #9ca3af;
  font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 4px;
}
.x:hover { background: #eef0f2; color: #374151; }
.body { padding: 10px; }
.msg { color: #374151; margin-bottom: 8px; }
.diff {
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #f7f8f9; border-radius: 6px; padding: 7px 9px;
  word-break: break-word; white-space: pre-wrap;
}
.diff del { color: #9ca3af; text-decoration: line-through; text-decoration-color: #d1d5db; }
.diff .arrow { color: #9ca3af; margin: 0 6px; }
.diff ins { color: #047857; text-decoration: none; font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 10px 10px; }
button.act {
  font: 500 12px/1 system-ui, sans-serif; cursor: pointer;
  border: 1px solid #d1d5db; background: #fff; color: #374151;
  border-radius: 6px; padding: 6px 10px;
}
button.act:hover { background: #f3f4f6; }
button.act.primary { background: #111827; border-color: #111827; color: #fff; }
button.act.primary:hover { background: #374151; }
.hint { padding: 0 10px 9px; font-size: 11px; color: #9ca3af; }
.errbox { padding: 10px; color: #991b1b; font-size: 12px; }

/* --- transform panel --- */
.ask {
  width: 100%; box-sizing: border-box;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #111827; background: #fff;
  border: 1px solid #d1d5db; border-radius: 6px; padding: 7px 9px;
}
.ask:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
.busy { display: flex; align-items: center; gap: 8px; color: #6b7280; }
.busy .spinner { border-color: rgba(0,0,0,.18); border-top-color: #6b7280; }
.out {
  white-space: pre-wrap; word-break: break-word;
  background: #f7f8f9; border-radius: 6px; padding: 8px 10px;
  max-height: 40vh; overflow: auto;
  /* It is a <textarea> so the answer can be tidied before it is applied. A textarea
     inherits none of this from the panel, hence the font and colour being named. */
  display: block; box-sizing: border-box; width: 100%; min-height: 84px;
  font: inherit; color: inherit; resize: vertical;
  border: 1px solid #e5e7eb;
}
.out:focus-visible { outline: 2px solid #3b82f6; outline-offset: 1px; }
.was {
  white-space: pre-wrap; word-break: break-word; color: #9ca3af;
  max-height: 12vh; overflow: auto; margin-bottom: 8px;
  border-left: 2px solid #e5e7eb; padding-left: 8px; font-size: 12px;
}
button.act:focus-visible { outline: 2px solid #3b82f6; outline-offset: 1px; }

@media (prefers-color-scheme: dark) {
  .card, .panel { background: #1f2430; color: #e5e7eb; border-color: #374151; }
  .ask { background: #151922; color: #e5e7eb; border-color: #3b4354; }
  .out { background: #151922; border-color: #374151; }
  .was { color: #6b7280; border-left-color: #374151; }
  .busy { color: #9ca3af; }
  .busy .spinner { border-color: rgba(255,255,255,.2); border-top-color: #9ca3af; }
  .head { background: #191d27; border-bottom-color: #2b3240; }
  .msg { color: #cbd5e1; }
  .diff { background: #151922; }
  .diff del { color: #6b7280; }
  .diff ins { color: #34d399; }
  button.act { background: #262c3a; border-color: #3b4354; color: #e5e7eb; }
  button.act:hover { background: #313949; }
  button.act.primary { background: #e5e7eb; border-color: #e5e7eb; color: #111827; }
  .x:hover { background: #2b3240; color: #e5e7eb; }
  .errbox { color: #fca5a5; }
}
`;

LAITA.Overlay = {
  host: null,
  shadow: null,
  /** [{ issue, rects:[{left,top,width,height}] }] in viewport coordinates */
  painted: [],

  ensure() {
    if (this.host?.isConnected) return;
    this.host = document.createElement("laita-layer");
    this.host.setAttribute("data-laita", "off");
    this.shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    this.layer = document.createElement("div");
    this.layer.className = "layer";
    this.clip = document.createElement("div");
    this.clip.className = "clip";
    this.pill = document.createElement("div");
    this.pill.className = "pill";
    this.card = document.createElement("div");
    this.card.className = "card";
    this.panel = document.createElement("div");
    this.panel.className = "panel";
    this.layer.append(this.clip, this.pill, this.card, this.panel);
    this.shadow.append(style, this.layer);
    document.documentElement.appendChild(this.host);
  },

  /** Draw a set of issues for a field. */
  render(adapter, issues, settings) {
    this.ensure();
    const clipRect = adapter.clipRect();
    Object.assign(this.clip.style, {
      left: clipRect.left + "px",
      top: clipRect.top + "px",
      width: clipRect.width + "px",
      height: clipRect.height + "px"
    });

    const frag = document.createDocumentFragment();
    const painted = [];
    for (const issue of issues) {
      const rects = adapter.rects(issue.start, issue.end);
      if (!rects.length) continue;
      const color = settings.colors[issue.type] || "#e5484d";
      const visible = [];
      for (const r of rects) {
        // Skip anything scrolled out of the field's visible box.
        if (r.top > clipRect.top + clipRect.height || r.top + r.height < clipRect.top) continue;
        const el = document.createElement("div");
        el.className = "deco" + (settings.tint ? " tint" : "");
        el.style.setProperty("--c", color);
        el.style.left = r.left - clipRect.left + "px";
        el.style.top = r.top - clipRect.top + "px";
        el.style.width = r.width + "px";
        el.style.height = r.height + "px";
        el.dataset.fp = issue.fp;
        frag.appendChild(el);
        visible.push(r);
      }
      if (visible.length) painted.push({ issue, rects: visible });
    }
    this.clip.replaceChildren(frag);
    this.painted = painted;
    LAITA.log(
      "painted", painted.length, "of", issues.length, "issues;",
      painted.reduce((n, p) => n + p.rects.length, 0), "rects in",
      `${Math.round(clipRect.width)}x${Math.round(clipRect.height)} at`,
      `${Math.round(clipRect.left)},${Math.round(clipRect.top)}`
    );
  },

  /**
   * Events raised inside a closed shadow root are retargeted to the host, so this is the
   * only reliable way for the document-level listeners to recognise our own UI and keep
   * their hands off it.
   */
  isOurs(node) {
    return !!node && !!this.host && (node === this.host || this.host.contains(node));
  },

  clearDecorations() {
    if (!this.host?.isConnected) return;
    this.clip.replaceChildren();
    this.painted = [];
  },

  /** Which issue, if any, sits under this viewport point. */
  hitTest(x, y) {
    for (const p of this.painted) {
      for (const r of p.rects) {
        // A couple of pixels of slack makes clicking a one-line highlight forgiving.
        if (x >= r.left - 1 && x <= r.left + r.width + 1 && y >= r.top - 2 && y <= r.top + r.height + 2) {
          return p.issue;
        }
      }
    }
    return null;
  },

  setHot(fp) {
    if (!this.host?.isConnected) return;
    for (const el of this.clip.children) el.classList.toggle("hot", !!fp && el.dataset.fp === fp);
  },

  /**
   * Small status pill, just outside the bottom-right of the field.
   * `onClose` gets a × that dismisses the pill and stops whatever it is reporting on.
   */
  showPill(adapter, { text, busy, error, onClose, onDetail }) {
    this.ensure();
    if (!text) {
      this.pill.classList.remove("on");
      return;
    }
    this.pill.classList.toggle("err", !!error);
    this.pill.replaceChildren();
    if (busy) {
      const s = document.createElement("div");
      s.className = "spinner";
      this.pill.appendChild(s);
    }
    this.pill.appendChild(document.createTextNode(text));
    if (onDetail) {
      const q = document.createElement("button");
      q.type = "button";
      q.className = "pillx";
      q.textContent = "?";
      q.title = "What went wrong";
      q.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onDetail();
      });
      this.pill.appendChild(q);
    }
    if (onClose) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "pillx";
      x.textContent = "×";
      x.title = busy ? "Stop this check" : "Hide";
      x.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      });
      this.pill.appendChild(x);
    }
    this.pill.classList.add("on");

    const r = adapter.clipRect();
    const size = { width: this.pill.offsetWidth || 90, height: this.pill.offsetHeight || 20 };
    const at = LAITA.pillPosition(r, size, { width: innerWidth, height: innerHeight });
    this.pill.classList.toggle("inside", at.where === "inside");
    this.pill.style.left = at.left + "px";
    this.pill.style.top = at.top + "px";
  },

  hidePill() {
    if (this.host?.isConnected) this.pill.classList.remove("on");
  },

  destroy() {
    this.host?.remove();
    this.host = null;
    this.painted = [];
  }
};
