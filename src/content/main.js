/**
 * Orchestration: watch the focused field, decide when to check it, farm the chunks out to
 * the background page, and keep the drawing in sync with whatever the page does afterwards.
 */

(() => {
  if (window.__locaispellLoaded) return;
  window.__locaispellLoaded = true;

  /** @type {InstanceType<any>|null} */
  let adapter = null;
  let issues = [];
  let generation = 0;
  let debounceTimer = null;
  let lastCheckedText = null;
  /** Which part of `lastCheckedText` was checked; ALL means "no need to look again". */
  let lastCheckedRange = null;
  const ALL = "*";
  let busyChunks = 0;
  let lastError = null;
  let currentLang = null;
  let repositionQueued = false;

  // ---------------------------------------------------------------- settings

  async function loadSettings() {
    const res = await LAS.send({ cmd: "getConfigFor", hostname: location.hostname });
    if (!res) return false;
    LAS.settings = res.settings;
    LAS.active = res.active;
    return true;
  }

  // ---------------------------------------------------------------- field tracking

  function detach({ keepHighlights = false } = {}) {
    clearTimeout(debounceTimer);
    generation++;
    if (adapter) LAS.send({ cmd: "cancel", clientId: LAS.clientId, gen: generation });
    LAS.Card.hide();
    if (!keepHighlights) {
      LAS.Overlay.clearDecorations();
      LAS.Overlay.hidePill();
      issues = [];
    }
    adapter?.destroy();
    adapter = null;
    lastCheckedText = null;
    lastError = null;
    busyChunks = 0;
    reportStatus();
  }

  function attach(el) {
    if (adapter && adapter.el === el) return;
    const next = LAS.adapterFor(el);
    // Focus moving to a button or a link should not wipe the highlights of the field
    // the user was just editing, so only tear down for another checkable field.
    if (!next) return;
    detach();
    adapter = next;
    LAS.log("attached to", el);
    if (LAS.settings.triggerMode === "auto") schedule(0);
  }

  /** The field main.js is currently driving, so transform.js can reuse its adapter
   *  instead of building a second layout mirror for the same element. */
  LAS.getAdapter = () => adapter;

  function schedule(delay) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runCheck(false), delay ?? LAS.settings.debounceMs);
  }

  // ---------------------------------------------------------------- checking

  async function runCheck(force) {
    if (!adapter || !LAS.active || !LAS.settings.enabled) return;
    if (!adapter.isAlive()) return detach();

    adapter.invalidate();
    const text = adapter.getText();

    if (text.trim().length < LAS.settings.minChars) {
      issues = [];
      lastError = null;
      LAS.Overlay.clearDecorations();
      LAS.Overlay.hidePill();
      reportStatus();
      return;
    }
    if (text.length > LAS.settings.maxChars) {
      lastError = `This field holds ${text.length} characters, over the ${LAS.settings.maxChars} limit.`;
      showPill();
      return;
    }
    // Language and scope are worked out before anything is sent, because whether this
    // check is a duplicate now depends on *which* paragraph it would look at, not just
    // on the text. Nothing is cancelled until we know there is work to do.
    const lang =
      LAS.settings.language === "auto" ? await LAS.detectLanguage(text) : LAS.settings.language;
    if (!adapter?.isAlive()) return;

    const chunks = LAS.chunkText(text, LAS.settings.chunkMaxChars, lang);
    if (!chunks.length) return;

    // Scope. Opening a long document should not fire a request per paragraph before the
    // user has touched anything, so by default only the paragraph holding the caret is
    // checked and the rest is left until they work on it. An explicit check - the hotkey
    // or the toolbar button - always sweeps the whole field.
    let todo = chunks;
    let keep = [];
    if (!force && LAS.settings.checkScope === "caret" && chunks.length > 1) {
      const at = LAS.chunkAtCaret(chunks, adapter.caretIn());
      if (at === -1) {
        // No caret to work from yet. Checking something arbitrary would be worse than
        // waiting for the user to click or type.
        busyChunks = 0;
        showPill();
        return;
      }
      todo = [chunks[at]];
      // Everything already found elsewhere in the field stays on screen.
      keep = LAS.issuesOutside(issues, todo[0].start, todo[0].start + todo[0].text.length);
    }

    const rangeKey = todo.map((c) => c.start + "+" + c.text.length).join(",");
    const alreadyDone =
      text === lastCheckedText && (lastCheckedRange === ALL || lastCheckedRange === rangeKey);
    if (!force && alreadyDone) return;

    currentLang = lang;
    lastCheckedText = text;
    lastCheckedRange = force ? ALL : rangeKey;
    lastError = null;
    const gen = ++generation;

    LAS.log(
      "checking", todo.length, "of", chunks.length, "chunk(s), language:", currentLang,
      "field:", adapter.kind, "scope:", force ? "forced" : LAS.settings.checkScope
    );
    busyChunks = todo.length;
    const collected = [...keep];
    showPill();

    await Promise.all(
      todo.map(async (chunk) => {
        const res = await LAS.send({
          cmd: "checkChunk",
          text: chunk.text,
          lang: currentLang,
          clientId: LAS.clientId,
          gen
        });
        if (gen !== generation) return;
        busyChunks--;

        if (!res || !res.ok) {
          if (res?.stale) return;
          lastError = res?.error || LAS.sendFailure();
          showPill();
          return;
        }
        for (const issue of res.issues) {
          collected.push({ ...issue, start: issue.start + chunk.start, end: issue.end + chunk.start });
        }
        // Paint progressively: the first paragraph should not wait for the last.
        issues = LAS.reconcile(collected.slice(), adapter.getText());
        paint();
        showPill();
      })
    );

    if (gen !== generation) return;
    busyChunks = 0;
    showPill();
    reportStatus();
  }

  // ---------------------------------------------------------------- painting

  function paint() {
    if (!adapter?.isAlive()) return;
    adapter.invalidate();
    LAS.Overlay.render(adapter, issues, LAS.settings);
    if (LAS.Card.isOpen()) LAS.Card.follow(adapter);
  }

  /**
   * The × on the pill. Abandons the check in flight and does not start another one for the
   * same text, so dismissing the pill actually stops the work rather than only hiding it.
   */
  function cancelCheck() {
    clearTimeout(debounceTimer);
    generation++;
    LAS.send({ cmd: "cancel", clientId: LAS.clientId, gen: generation });
    busyChunks = 0;
    lastError = null;
    if (adapter?.isAlive()) {
      lastCheckedText = adapter.getText();
      lastCheckedRange = ALL;
    }
    LAS.Overlay.hidePill();
    reportStatus();
  }

  function showPill() {
    if (!adapter?.isAlive()) return;
    if (lastError) {
      LAS.Overlay.showPill(adapter, {
        text: "locaispell: error",
        error: true,
        onClose: cancelCheck,
        onDetail: () => LAS.Card.showError(adapter, lastError)
      });
      return;
    }
    if (busyChunks > 0) {
      LAS.Overlay.showPill(adapter, { text: "Checking…", busy: true, onClose: cancelCheck });
      return;
    }
    if (issues.length) {
      LAS.Overlay.showPill(adapter, {
        text: `${issues.length} suggestion${issues.length > 1 ? "s" : ""}`,
        onClose: cancelCheck
      });
      setTimeout(() => {
        if (busyChunks === 0 && !lastError) LAS.Overlay.hidePill();
      }, 1800);
      return;
    }
    LAS.Overlay.showPill(adapter, { text: "No issues", onClose: cancelCheck });
    setTimeout(() => {
      if (busyChunks === 0 && !lastError) LAS.Overlay.hidePill();
    }, 1200);
  }

  function reportStatus() {
    LAS.send({
      cmd: "status",
      state: { busy: busyChunks > 0, error: !!lastError, count: issues.length, worst: LAS.WORST(issues) }
    });
  }

  function queueReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      LAS.Transform.reposition();
      if (!adapter?.isAlive()) return;
      if (!issues.length && !LAS.Card.isOpen()) return;
      paint();
      if (LAS.Overlay.pill?.classList.contains("on")) showPill();
    });
  }

  // ---------------------------------------------------------------- actions on a suggestion

  function applyIssue(issue) {
    if (!adapter?.isAlive()) return;
    adapter.invalidate();
    const text = adapter.getText();
    if (text.slice(issue.start, issue.end) !== issue.original) {
      // The text moved under us; re-anchor everything and give up on this one.
      issues = LAS.reconcile(issues, text);
      paint();
      return;
    }

    // Retire this suggestion before the edit lands. applyFix dispatches an input event
    // synchronously, and that handler re-anchors whatever is left by searching for each
    // span's text, so the surviving issues must not also be shifted by hand here.
    issues = issues.filter((i) => i !== issue);
    adapter.applyFix(issue.start, issue.end, issue.replacement);

    adapter.invalidate();
    lastCheckedText = adapter.getText();
    lastCheckedRange = ALL;
    issues = LAS.reconcile(issues, lastCheckedText);
    paint();
    reportStatus();
  }

  function dropIssue(issue) {
    issues = issues.filter((i) => i !== issue);
    paint();
    reportStatus();
  }

  // ---------------------------------------------------------------- events

  document.addEventListener(
    "focusin",
    (e) => {
      if (!LAS.active) return;
      const target = e.target;
      if (LAS.Overlay.isOurs(target)) return;
      attach(target);
    },
    true
  );

  document.addEventListener(
    "input",
    (e) => {
      if (!adapter || e.target !== adapter.el && !adapter.el.contains(e.target)) return;
      adapter.invalidate();
      // Shift highlights with the edit right away so they do not lag behind the caret.
      issues = LAS.reconcile(issues, adapter.getText());
      paint();
      if (LAS.Card.isOpen()) LAS.Card.hide();
      if (LAS.settings.triggerMode === "auto") schedule();
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      // A click on our own card must reach the card's buttons untouched.
      if (LAS.Overlay.isOurs(e.target)) return;
      if (!adapter?.isAlive()) return;
      const hit = LAS.Overlay.hitTest(e.clientX, e.clientY);
      if (!hit) {
        if (LAS.Card.isOpen()) LAS.Card.hide();
        return;
      }
      const rects = adapter.rects(hit.start, hit.end);
      LAS.Overlay.setHot(hit.fp);
      LAS.Card.show({
        issue: hit,
        lang: currentLang,
        anchorRect: rects[0] || { left: e.clientX, top: e.clientY, width: 0, height: 0 },
        onApply: applyIssue,
        onDismiss: dropIssue,
        onNever: (issue) => {
          LAS.send({ cmd: "ignoreSuggestion", fp: issue.fp });
          dropIssue(issue);
        },
        onDictionary: (issue) => {
          LAS.send({ cmd: "addToDictionary", word: issue.original });
          dropIssue(issue);
        }
      });
    },
    true
  );

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!LAS.active || !issues.length) return;
      const hit = LAS.Overlay.hitTest(e.clientX, e.clientY);
      LAS.Overlay.setHot(hit ? hit.fp : LAS.Card.current?.issue.fp || null);
    },
    { capture: true, passive: true }
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && LAS.Transform.isOpen()) {
      LAS.Transform.close();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape" && LAS.Card.isOpen()) {
      LAS.Card.hide();
      e.stopPropagation();
    }
  }, true);

  addEventListener("scroll", queueReposition, { capture: true, passive: true });
  addEventListener("resize", queueReposition, { passive: true });

  const ro = new ResizeObserver(queueReposition);
  let observed = null;
  setInterval(() => {
    if (adapter?.el !== observed) {
      if (observed) ro.unobserve(observed);
      observed = adapter?.el || null;
      if (observed) ro.observe(observed);
    }
    if (adapter && !adapter.isAlive()) detach();
  }, 700);

  browser.runtime.onMessage.addListener(async (msg) => {
    if (msg.cmd === "checkNow") {
      const el = document.activeElement;
      if (el && (!adapter || adapter.el !== el)) attach(el);
      if (!adapter) return { ok: false, reason: "no-field" };
      await runCheck(true);
      return { ok: true };
    }
    if (msg.cmd === "transformSelection") {
      return LAS.Transform.open();
    }
    if (msg.cmd === "settingsChanged") {
      const wasActive = LAS.active;
      await loadSettings();
      if (!LAS.active) detach();
      else if (!wasActive && document.activeElement) attach(document.activeElement);
      else if (adapter) {
        lastCheckedText = null;
        paint();
      }
      return { ok: true };
    }
    if (msg.cmd === "getFieldState") {
      return {
        ok: true,
        hasField: !!adapter,
        count: issues.length,
        lang: currentLang,
        busy: busyChunks > 0,
        error: lastError
      };
    }
    return undefined;
  });

  // ---------------------------------------------------------------- boot

  loadSettings().then(() => {
    if (LAS.active && document.activeElement) attach(document.activeElement);
  });
})();
