/** The popup card shown when a highlight is clicked. Lives inside the overlay's shadow root. */

const LABEL = {
  error: { en: "Error", fr: "Erreur", it: "Errore", es: "Error", de: "Fehler" },
  style: { en: "Style", fr: "Style", it: "Stile", es: "Estilo", de: "Stil" },
  rephrase: { en: "Rephrase", fr: "Reformuler", it: "Riformulare", es: "Reformular", de: "Umformulieren" }
};

const ACTIONS = {
  apply: { en: "Apply", fr: "Appliquer", it: "Applica", es: "Aplicar", de: "Anwenden" },
  dismiss: { en: "Dismiss", fr: "Ignorer", it: "Ignora", es: "Descartar", de: "Verwerfen" },
  never: { en: "Never suggest", fr: "Ne plus proposer", it: "Non proporre piu", es: "No sugerir mas", de: "Nie vorschlagen" },
  dict: { en: "Add to dictionary", fr: "Ajouter au dictionnaire", it: "Aggiungi al dizionario", es: "Anadir al diccionario", de: "Zum Worterbuch" }
};

const t = (table, lang) => table[lang] || table.en;

LAITA.Card = {
  current: null,

  /**
   * @param {object} opts { issue, lang, anchorRect, onApply, onDismiss, onNever, onDictionary }
   */
  show(opts) {
    const O = LAITA.Overlay;
    O.ensure();
    const { issue, lang } = opts;
    const card = O.card;
    const color = LAITA.settings.colors[issue.type] || "#e5484d";
    this.current = opts;

    card.replaceChildren();
    card.style.setProperty("--c", color);

    const head = el("div", "head");
    head.append(
      el("span", "badge", t(LABEL[issue.type], lang)),
      el("span", "lang", lang || ""),
      el("div", "spacer")
    );
    const close = el("button", "x", "×");
    close.title = "Close";
    close.addEventListener("click", () => this.hide());
    head.appendChild(close);

    const body = el("div", "body");
    if (issue.message) body.appendChild(el("div", "msg", issue.message));
    const diff = el("div", "diff");
    diff.append(
      Object.assign(document.createElement("del"), { textContent: issue.original }),
      el("span", "arrow", "→"),
      Object.assign(document.createElement("ins"), { textContent: issue.replacement })
    );
    body.appendChild(diff);

    const actions = el("div", "actions");
    actions.appendChild(button(t(ACTIONS.apply, lang), "primary", () => {
      this.hide();
      opts.onApply?.(issue);
    }));
    actions.appendChild(button(t(ACTIONS.dismiss, lang), "", () => {
      this.hide();
      opts.onDismiss?.(issue);
    }));
    actions.appendChild(button(t(ACTIONS.never, lang), "", () => {
      this.hide();
      opts.onNever?.(issue);
    }));
    // Only offer the dictionary for something that actually looks like a single word.
    if (/^[\p{L}\p{M}'-]{2,40}$/u.test(issue.original)) {
      actions.appendChild(button(t(ACTIONS.dict, lang), "", () => {
        this.hide();
        opts.onDictionary?.(issue);
      }));
    }

    card.append(head, body, actions);
    card.classList.add("on");
    this.position(opts.anchorRect);
  },

  position(rect) {
    const card = LAITA.Overlay.card;
    if (!card?.classList.contains("on")) return;
    LAITA.placeNear(card, rect);
  },

  /** Reposition against the live geometry of the issue we are anchored to. */
  follow(adapter) {
    if (!this.current) return;
    const rects = adapter.rects(this.current.issue.start, this.current.issue.end);
    if (!rects.length) {
      this.hide();
      return;
    }
    this.current.anchorRect = rects[0];
    this.position(rects[0]);
  },

  showError(adapter, message) {
    const O = LAITA.Overlay;
    O.ensure();
    const card = O.card;
    this.current = null;
    card.replaceChildren();
    card.style.setProperty("--c", "#e5484d");
    const head = el("div", "head");
    head.append(el("span", "badge", "LAITA"), el("div", "spacer"));
    const close = el("button", "x", "×");
    close.addEventListener("click", () => this.hide());
    head.appendChild(close);
    card.append(head, el("div", "errbox", message));
    card.classList.add("on");
    const r = adapter.clipRect();
    this.position({ left: r.left, top: r.top, width: r.width, height: r.height });
  },

  hide() {
    this.current = null;
    const card = LAITA.Overlay.card;
    if (card) {
      card.classList.remove("on");
      card.replaceChildren();
    }
    LAITA.Overlay.setHot(null);
  },

  isOpen() {
    return !!LAITA.Overlay.card?.classList.contains("on");
  }
};

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
