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
    if (!force && text === lastCheckedText) return;

    lastCheckedText = text;
    lastError = null;
    const gen = ++generation;

    currentLang =
      LAS.settings.language === "auto" ? await LAS.detectLanguage(text) : LAS.settings.language;
    if (gen !== generation) return;

    const chunks = LAS.chunkText(text, LAS.settings.chunkMaxChars, currentLang);
    if (!chunks.length) return;

    LAS.log("checking", chunks.length, "chunk(s), language:", currentLang, "field:", adapter.kind);
    busyChunks = chunks.length;
    const collected = [];
    showPill();

    await Promise.all(
      chunks.map(async (chunk) => {
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
          lastError = res?.error || "Local AI Spell Checker could not reach the model.";
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

  function showPill() {
    if (!adapter?.isAlive()) return;
    if (lastError) {
      LAS.Overlay.showPill(adapter, { text: "locaispell: error", error: true });
      return;
    }
    if (busyChunks > 0) {
      LAS.Overlay.showPill(adapter, { text: "Checking…", busy: true });
      return;
    }
    if (issues.length) {
      LAS.Overlay.showPill(adapter, { text: `${issues.length} suggestion${issues.length > 1 ? "s" : ""}` });
      setTimeout(() => {
        if (busyChunks === 0 && !lastError) LAS.Overlay.hidePill();
      }, 1800);
      return;
    }
    LAS.Overlay.showPill(adapter, { text: "No issues" });
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
