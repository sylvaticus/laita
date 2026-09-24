/**
 * Orchestration: watch the focused field, decide when to check it, farm the chunks out to
 * the background page, and keep the drawing in sync with whatever the page does afterwards.
 */

(() => {
  if (window.__laitaLoaded) return;
  window.__laitaLoaded = true;

  /** @type {InstanceType<any>|null} */
  let adapter = null;

  // The observer follows attach/detach directly rather than being re-checked on a timer.
  // The timer version ran in every frame of every page for the life of the tab - a dozen
  // ad iframes meant a dozen of them - whether or not a field was focused and whether or
  // not the extension was even enabled for the site.
  //
  // The liveness half is still a poll, because a field can be removed from the DOM by any
  // script with no event we can subscribe to, but it now exists only while a field is
  // actually attached: it starts in attach() and stops in detach(). An idle tab runs
  // nothing at all.
  const ro = new ResizeObserver(() => queueReposition());
  let observed = null;
  let livenessTimer = null;
  /** One handle, not one per call: showPill runs once per chunk plus twice more, so a
   *  five-chunk sweep used to leave seven timers racing to hide the same pill. Declared
   *  here because detach() below clears it and would otherwise touch it before the
   *  declaration was evaluated. */
  let pillHideTimer = null;
  let issues = [];
  let generation = 0;
  let debounceTimer = null;
  let lastCheckedText = null;
  /** Which part of `lastCheckedText` was checked; ALL means "no need to look again". */
  let lastCheckedRange = null;
  const ALL = "*";
  let busyChunks = 0;
  /** The generation of the whole-field check running now, or null. It is what the popup's
   *  Check / Stop the whole field button and Alt+Shift+C read: a whole-field check and
   *  checking as you type are separate switches, as in the other LAITA surfaces. */
  let wholeGen = null;
  const wholeRunning = () => wholeGen !== null && wholeGen === generation && busyChunks > 0;
  let lastError = null;
  let currentLang = null;
  let repositionQueued = false;

  // ---------------------------------------------------------------- settings

  async function loadSettings() {
    const res = await LAITA.send({ cmd: "getConfigFor", hostname: location.hostname });
    if (!res) return false;
    LAITA.settings = res.settings;
    LAITA.active = res.active;
    return true;
  }

  // ---------------------------------------------------------------- field tracking

  function detach({ keepHighlights = false } = {}) {
    clearTimeout(debounceTimer);
    generation++;
    if (adapter) LAITA.send({ cmd: "cancel", clientId: LAITA.clientId, gen: generation });
    LAITA.Card.hide();
    if (!keepHighlights) {
      LAITA.Overlay.clearDecorations();
      LAITA.Overlay.hidePill();
      issues = [];
    }
    if (observed) {
      ro.unobserve(observed);
      observed = null;
    }
    clearInterval(livenessTimer);
    livenessTimer = null;
    clearTimeout(pillHideTimer);
    pillHideTimer = null;
    adapter?.destroy();
    adapter = null;
    lastCheckedText = null;
    lastError = null;
    busyChunks = 0;
    reportStatus();
  }

  function attach(el) {
    if (adapter && adapter.el === el) return;
    const next = LAITA.adapterFor(el);
    // Focus moving to a button or a link should not wipe the highlights of the field
    // the user was just editing, so only tear down for another checkable field.
    if (!next) return;
    detach();
    adapter = next;
    observed = el;
    ro.observe(el);
    livenessTimer = setInterval(() => {
      if (adapter && !adapter.isAlive()) detach();
    }, 700);
    LAITA.log("attached to", el);
    if (LAITA.settings.triggerMode === "auto") schedule(0);
  }

  /** The field main.js is currently driving, so transform.js can reuse its adapter
   *  instead of building a second layout mirror for the same element. */
  LAITA.getAdapter = () => adapter;

  function schedule(delay) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runCheck(false), delay ?? LAITA.settings.debounceMs);
  }

  // ---------------------------------------------------------------- checking

  async function runCheck(force) {
    if (!adapter || !LAITA.active || !LAITA.settings.enabled) return;
    if (!adapter.isAlive()) return detach();

    adapter.invalidate();
    const text = adapter.getText();

    if (text.trim().length < LAITA.settings.minChars) {
      issues = [];
      lastError = null;
      LAITA.Overlay.clearDecorations();
      LAITA.Overlay.hidePill();
      reportStatus();
      return;
    }
    // Language and scope are worked out before anything is sent, because whether this
    // check is a duplicate now depends on *which* paragraph it would look at, not just
    // on the text. Nothing is cancelled until we know there is work to do.
    const lang =
      LAITA.settings.language === "auto" ? await LAITA.detectLanguage(text) : LAITA.settings.language;
    if (!adapter?.isAlive()) return;

    const chunks = LAITA.chunkText(text, LAITA.settings.chunkMaxChars, lang);
    if (!chunks.length) return;

    // Scope. Opening a long document should not fire a request per paragraph before the
    // user has touched anything, so by default only the paragraph holding the caret is
    // checked and the rest is left until they work on it. An explicit check - the hotkey
    // or the toolbar button - always sweeps the whole field.
    let todo = chunks;
    let keep = [];
    if (!force && LAITA.settings.checkScope === "caret" && chunks.length > 1) {
      const at = LAITA.chunkAtCaret(chunks, adapter.caretIn());
      if (at === -1) {
        // No caret to work from yet. Checking something arbitrary would be worse than
        // waiting for the user to click or type.
        busyChunks = 0;
        showPill();
        return;
      }
      todo = [chunks[at]];
      // Everything already found elsewhere in the field stays on screen.
      keep = LAITA.issuesOutside(issues, todo[0].start, todo[0].start + todo[0].text.length);
    }

    // The cap is on what this check would send, not on how long the document is. A
    // 20-page post is fine when only the paragraph under the caret goes out; it is a
    // whole-field sweep of one that is not.
    const sending = todo.reduce((n, c) => n + c.text.length, 0);
    if (sending > LAITA.settings.maxChars) {
      lastError =
        `Checking all of this field would send ${sending} characters, over the ` +
        `${LAITA.settings.maxChars} limit in the options. Typing in a paragraph still ` +
        `checks that paragraph.`;
      busyChunks = 0;
      showPill();
      return;
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
    wholeGen = force ? gen : null;      // any newer check supersedes a whole-field one

    LAITA.log(
      "checking", todo.length, "of", chunks.length, "chunk(s), language:", currentLang,
      "field:", adapter.kind, "scope:", force ? "forced" : LAITA.settings.checkScope
    );
    busyChunks = todo.length;
    // What each chunk shows until its own answer arrives. For a whole-field check that is
    // everything already there: starting from nothing, as this used to, meant stopping
    // it halfway wiped the highlights of every chunk it had not reached yet.
    let kept = force ? issues.slice() : keep;
    const collected = [];
    showPill();

    await Promise.all(
      todo.map(async (chunk) => {
        const res = await LAITA.send({
          cmd: "checkChunk",
          text: chunk.text,
          lang: currentLang,
          clientId: LAITA.clientId,
          gen
        });
        if (gen !== generation) return;
        busyChunks--;

        if (!res || !res.ok) {
          if (res?.stale) return;
          lastError = res?.error || LAITA.sendFailure();
          showPill();
          return;
        }
        kept = LAITA.issuesOutside(kept, chunk.start, chunk.start + chunk.text.length);
        for (const issue of res.issues) {
          collected.push({ ...issue, start: issue.start + chunk.start, end: issue.end + chunk.start });
        }
        // Paint progressively: the first paragraph should not wait for the last.
        issues = LAITA.reconcile([...kept, ...collected], adapter.getText());
        paint();
        showPill();
      })
    );

    if (gen !== generation) return;
    busyChunks = 0;
    wholeGen = null;
    showPill();
    reportStatus();
  }

  // ---------------------------------------------------------------- painting

  function paint() {
    if (!adapter?.isAlive()) return;
    adapter.invalidate();
    LAITA.Overlay.render(adapter, issues, LAITA.settings);
    if (LAITA.Card.isOpen()) LAITA.Card.follow(adapter);
  }

  /**
   * The × on the pill. Abandons the check in flight and does not start another one for the
   * same text, so dismissing the pill actually stops the work rather than only hiding it.
   */
  function cancelCheck() {
    clearTimeout(debounceTimer);
    generation++;
    wholeGen = null;
    LAITA.send({ cmd: "cancel", clientId: LAITA.clientId, gen: generation });
    busyChunks = 0;
    lastError = null;
    if (adapter?.isAlive()) {
      lastCheckedText = adapter.getText();
      lastCheckedRange = ALL;
    }
    LAITA.Overlay.hidePill();
    reportStatus();
  }

  function hidePillIn(ms) {
    clearTimeout(pillHideTimer);
    pillHideTimer = setTimeout(() => {
      pillHideTimer = null;
      if (busyChunks === 0 && !lastError) LAITA.Overlay.hidePill();
    }, ms);
  }

  function showPill() {
    if (!adapter?.isAlive()) return;
    clearTimeout(pillHideTimer);
    pillHideTimer = null;
    if (lastError) {
      LAITA.Overlay.showPill(adapter, {
        text: "LAITA: error",
        error: true,
        onClose: cancelCheck,
        onDetail: () => LAITA.Card.showError(adapter, lastError)
      });
      return;
    }
    if (busyChunks > 0) {
      LAITA.Overlay.showPill(adapter, { text: "Checking…", busy: true, onClose: cancelCheck });
      return;
    }
    if (issues.length) {
      LAITA.Overlay.showPill(adapter, {
        text: `${issues.length} suggestion${issues.length > 1 ? "s" : ""}`,
        onClose: cancelCheck
      });
      hidePillIn(1800);
      return;
    }
    LAITA.Overlay.showPill(adapter, { text: "No issues", onClose: cancelCheck });
    hidePillIn(1200);
  }

  function reportStatus() {
    LAITA.send({
      cmd: "status",
      state: { busy: busyChunks > 0, error: !!lastError, count: issues.length, worst: LAITA.WORST(issues) }
    });
  }

  function queueReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      LAITA.Transform.reposition();
      if (!adapter?.isAlive()) return;
      if (!issues.length && !LAITA.Card.isOpen()) return;
      paint();
      if (LAITA.Overlay.pill?.classList.contains("on")) showPill();
    });
  }

  // ---------------------------------------------------------------- actions on a suggestion

  function applyIssue(issue) {
    if (!adapter?.isAlive()) return;
    adapter.invalidate();
    const text = adapter.getText();
    if (text.slice(issue.start, issue.end) !== issue.original) {
      // The text moved under us; re-anchor everything and give up on this one.
      issues = LAITA.reconcile(issues, text);
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
    issues = LAITA.reconcile(issues, lastCheckedText);
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
      if (!LAITA.active) return;
      const target = e.target;
      if (LAITA.Overlay.isOurs(target)) return;
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
      issues = LAITA.reconcile(issues, adapter.getText());
      paint();
      if (LAITA.Card.isOpen()) LAITA.Card.hide();
      if (LAITA.settings.triggerMode === "auto") schedule();
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      // A click on our own card must reach the card's buttons untouched.
      if (LAITA.Overlay.isOurs(e.target)) return;
      if (!adapter?.isAlive()) return;
      const hit = LAITA.Overlay.hitTest(e.clientX, e.clientY);
      if (!hit) {
        if (LAITA.Card.isOpen()) LAITA.Card.hide();
        return;
      }
      const rects = adapter.rects(hit.start, hit.end);
      LAITA.Overlay.setHot(hit.fp);
      LAITA.Card.show({
        issue: hit,
        lang: currentLang,
        anchorRect: rects[0] || { left: e.clientX, top: e.clientY, width: 0, height: 0 },
        onApply: applyIssue,
        onDismiss: dropIssue,
        onNever: (issue) => {
          LAITA.send({ cmd: "ignoreSuggestion", fp: issue.fp });
          dropIssue(issue);
        },
        onDictionary: (issue) => {
          LAITA.send({ cmd: "addToDictionary", word: issue.original });
          dropIssue(issue);
        }
      });
    },
    true
  );

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!LAITA.active || !issues.length) return;
      const hit = LAITA.Overlay.hitTest(e.clientX, e.clientY);
      LAITA.Overlay.setHot(hit ? hit.fp : LAITA.Card.current?.issue.fp || null);
    },
    { capture: true, passive: true }
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && LAITA.Transform.isOpen()) {
      LAITA.Transform.close();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape" && LAITA.Card.isOpen()) {
      LAITA.Card.hide();
      e.stopPropagation();
    }
  }, true);

  addEventListener("scroll", queueReposition, { capture: true, passive: true });
  addEventListener("resize", queueReposition, { passive: true });


  browser.runtime.onMessage.addListener(async (msg) => {
    // Stopping a whole-field check is the pill's ×: it abandons that check and nothing
    // else, so checking as you type carries on with the next edit.
    if (msg.cmd === "stopWholeCheck" ||
        (msg.cmd === "toggleWholeCheck" && wholeRunning())) {
      if (wholeRunning()) cancelCheck();
      return { ok: true, stopped: true };
    }
    if (msg.cmd === "checkNow" || msg.cmd === "toggleWholeCheck") {
      const el = document.activeElement;
      if (el && (!adapter || adapter.el !== el)) attach(el);
      if (!adapter) return { ok: false, reason: "no-field" };
      await runCheck(true);
      return { ok: true };
    }
    if (msg.cmd === "transformSelection") {
      return LAITA.Transform.open();
    }
    // The background page used to read tab.url, which needs a host permission over every
    // site. It no longer holds one, and does not need to: the page knows where it is.
    // The toolbar popup asks before drawing its Transform button. It is a separate
    // question from getFieldState, which is about the focused field rather than a
    // selection - a selection in ordinary page text has no field at all.
    if (msg.cmd === "peekSelection") {
      return LAITA.Transform.peek();
    }
    if (msg.cmd === "hostname") {
      return { ok: true, hostname: location.hostname };
    }
    if (msg.cmd === "settingsChanged") {
      const wasActive = LAITA.active;
      const wasTyping = LAITA.settings?.triggerMode === "auto";
      await loadSettings();
      if (!LAITA.active) detach();
      else if (!wasActive && document.activeElement) attach(document.activeElement);
      else if (adapter) {
        lastCheckedText = null;
        paint();
        // Checking as you type just came back on: look at what was typed while it was
        // off, since only an edit would otherwise start a check. The highlights already
        // there were kept all along - switching it off never clears them.
        if (!wasTyping && LAITA.settings.triggerMode === "auto") schedule(0);
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
        whole: wholeRunning(),
        error: lastError
      };
    }
    return undefined;
  });

  // ---------------------------------------------------------------- boot

  loadSettings().then(() => {
    if (LAITA.active && document.activeElement) attach(document.activeElement);
  });
})();
