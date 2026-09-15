/**
 * LAITA for VS Code.
 *
 * The browser extension draws its own overlay because a web page offers nothing better.
 * VS Code does: diagnostics give squiggles, hovers and the Problems panel for free, and
 * code actions give "apply this fix" with the keybinding users already know. So the
 * surface here is deliberately native, and only the language work is shared with the
 * browser - `core/ollama.js` (prompts, transport, error classification) and
 * `core/anchor.js` (turning the model's quoted substring into exact offsets).
 *
 * CommonJS, because VS Code's extension host loads `main` as CommonJS. The shared core
 * is ESM and is pulled in with a dynamic import at activation.
 */
const vscode = require("vscode");
const { detectLanguage, paragraphs, paragraphAt, isProse, chunkParagraph, chunkAt } =
  require("./text.js");

let core = null;                 // { requestIssues, requestTransform, anchorIssues, ... }
let diagnostics;                 // vscode.DiagnosticCollection
let status;                      // vscode.StatusBarItem
/** Diagnostic -> the issue it came from, so a code action can apply the right fix. */
const fixes = new WeakMap();
/** uri -> debounce timer, for checking as you type. */
const pending = new Map();
/** uri -> the paragraph text last sent, so an unchanged paragraph is not re-sent. */
const lastSent = new Map();

/**
 * Raw model answers, keyed by the text and everything that changes what the model would
 * say. Typing in a paragraph re-checks it every time you pause, and moving back to a
 * paragraph checked a minute ago would otherwise pay the full cost again - seconds, or
 * minutes on a long one. The browser extension keeps the same cache for the same reason.
 *
 * Raw rather than anchored, so that adding a word to the dictionary or turning off a
 * category needs no invalidation: only the prompt inputs are part of the key.
 */
const CACHE_MAX = 400;
const cache = new Map();

function cacheKey(text, lang, s) {
  const cats = ["error", "style", "rephrase"].map((c) => (s.categories[c] ? "1" : "0")).join("");
  return [core.hash(text), text.length, lang, s.model, s.temperature, cats,
          core.hash((s.dictionary || []).join(",")),
          core.hash(s.extraInstructions || "")].join("|");
}

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const v = cache.get(key);
  cache.delete(key);            // refresh LRU position
  cache.set(key, v);
  return v;
}

function cacheSet(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * Category to diagnostic severity.
 *
 * Not `Error` for anything: this is prose, not a build, and red is for things that stop
 * work. Not `Hint` either, which was the first choice for rephrase and was wrong -
 * VS Code draws a Hint as three dots under the start of the range rather than
 * underlining it, so a suggestion spanning "too well english" appeared to cover only
 * the "t". The range was right; the rendering hid it. Configurable, because how loud a
 * style note should be is a matter of taste.
 */
const SEVERITY_NAMES = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint
};

function severityFor(type) {
  const chosen = vscode.workspace.getConfiguration("laita").get("severity." + type);
  return SEVERITY_NAMES[chosen] ?? vscode.DiagnosticSeverity.Information;
}

// ---------------------------------------------------------------- settings

/** The shape `core/ollama.js` expects, built from VS Code's configuration. */
function settings() {
  const c = vscode.workspace.getConfiguration("laita");
  return {
    endpoint: c.get("endpoint"),
    model: c.get("model"),
    temperature: c.get("temperature"),
    numCtx: c.get("numCtx"),
    keepAlive: c.get("keepAlive"),
    think: c.get("think"),
    requestTimeoutMs: c.get("requestTimeoutMs"),
    maxChars: c.get("maxChars"),
    chunkMaxChars: c.get("chunkMaxChars"),
    dictionary: c.get("dictionary"),
    extraInstructions: c.get("extraInstructions"),
    categories: {
      error: c.get("categories.error"),
      style: c.get("categories.style"),
      rephrase: c.get("categories.rephrase")
    },
    ignored: c.get("ignored") || []
  };
}

function languageFor(text) {
  const pinned = vscode.workspace.getConfiguration("laita").get("language");
  return !pinned || pinned === "auto" ? detectLanguage(text) : pinned;
}

// ---------------------------------------------------------------- running the model

/**
 * Check one span of a document and turn what comes back into diagnostics.
 * `offset` is where `text` starts in the document, so anchored offsets land correctly.
 */
async function checkSpan(doc, text, offset, s, token) {
  const lang = languageFor(text);
  const key = cacheKey(text, lang, s);
  let raw = cacheGet(key);
  if (raw === undefined) {
    raw = await core.requestIssues({ text, lang, settings: s, signal: token });
    cacheSet(key, raw);
  }
  const anchored = core.anchorIssues(text, raw,
    { categories: s.categories, ignored: s.ignored });

  return anchored.flatMap((issue) => {
    const range = rangeForIssue(doc, offset, issue);
    if (!range) return [];
    const d = new vscode.Diagnostic(range, issue.message || "Suggested change",
                                    severityFor(issue.type));
    d.source = "LAITA";
    d.code = issue.type;
    fixes.set(d, issue);
    return [d];
  });
}

/**
 * What the model should look at, as {text, offset} pieces.
 *
 * A long paragraph is split, because latency grows faster than length. When `caret` is
 * given - any automatic check - only the piece being worked on is sent, which is what
 * makes editing a long paragraph bearable. An explicit "check the document" passes no
 * caret and gets everything.
 */
function piecesFor(doc, paras, s, caret = null) {
  const pieces = [];
  for (const p of paras) {
    const range = new vscode.Range(p.start, 0, p.end, doc.lineAt(p.end).text.length);
    const text = doc.getText(range);
    if (!isProse(text, p.code)) continue;

    const base = doc.offsetAt(range.start);
    const chunks = chunkParagraph(text, s.chunkMaxChars, languageFor(text));
    // An automatic check always sends exactly one piece. If the caret is not inside
    // this paragraph - it sits on the title when a document is first opened - the first
    // piece is the one worth showing, not all of them.
    const wanted = caret === null ? chunks : [chunkAt(chunks, caret - base) || chunks[0]];
    for (const c of wanted) {
      if (!isProse(c.text, false)) continue;
      pieces.push({ text: c.text, offset: base + c.offset });
    }
  }
  return pieces;
}

async function run(doc, paras, label, caret = null) {
  if (!core) return;
  const s = settings();
  const pieces = piecesFor(doc, paras, s, caret);
  if (!pieces.length) {
    vscode.window.setStatusBarMessage("LAITA: nothing to check here", 2500);
    return;
  }

  const sending = pieces.reduce((n, p) => n + p.text.length, 0);
  if (sending > s.maxChars) {
    vscode.window.showWarningMessage(
      `LAITA: that would send ${sending} characters, over the ${s.maxChars} limit ` +
      `(laita.maxChars). Check a paragraph instead, or raise the limit.`);
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `LAITA: ${label}`, cancellable: true },
    async (progress, cancel) => {
      const controller = new AbortController();
      cancel.onCancellationRequested(() => controller.abort());
      const timer = setTimeout(() => controller.abort(), s.requestTimeoutMs);

      // Keep what is already known outside the spans being rechecked.
      const covered = pieces.map((p) => [p.offset, p.offset + p.text.length]);
      const kept = (diagnostics.get(doc.uri) || []).filter((d) => {
        const a = doc.offsetAt(d.range.start), b = doc.offsetAt(d.range.end);
        return !covered.some(([x, y]) => a < y && b > x);
      });

      const found = [];
      try {
        for (const [i, piece] of pieces.entries()) {
          if (controller.signal.aborted) break;
          progress.report({ message: pieces.length > 1 ? `${i + 1}/${pieces.length}` : undefined });
          found.push(...await checkSpan(doc, piece.text, piece.offset, s, controller.signal));
          diagnostics.set(doc.uri, [...kept, ...found]);   // paint as they arrive
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          vscode.window.showErrorMessage("LAITA: " + core.describeError(err).error);
        }
      } finally {
        clearTimeout(timer);
      }
      refreshStatus(doc);
    });
}

// ---------------------------------------------------------------- commands

async function checkParagraph() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const lines = ed.document.getText().split(/\r?\n/);
  const p = paragraphAt(lines, ed.selection.active.line);
  if (!p) return vscode.window.setStatusBarMessage("LAITA: no paragraph at the cursor", 2500);
  await run(ed.document, [p], "checking this paragraph", ed.document.offsetAt(ed.selection.active));
}

async function checkDocument() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const lines = ed.document.getText().split(/\r?\n/);
  await run(ed.document, paragraphs(lines), "checking the document");
}

async function transform() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) {
    return vscode.window.showInformationMessage("LAITA: select some text first.");
  }
  const s = settings();
  const selected = ed.document.getText(ed.selection);
  if (selected.length > s.maxChars) {
    return vscode.window.showWarningMessage(
      `LAITA: that selection is ${selected.length} characters, over the ${s.maxChars} limit.`);
  }

  const fallback = vscode.workspace.getConfiguration("laita").get("transformDefault") || "polish";
  const instruction = (await vscode.window.showInputBox({
    title: "LAITA: transform the selection",
    prompt: "What should I do with it?",
    placeHolder: `polish · translate to French · shorten it   (empty = ${fallback})`
  }))?.trim();
  if (instruction === undefined) return;               // dismissed, as opposed to empty

  const minutes = Math.max(1, Math.round(selected.length / 4 / 10 / 60));
  const note = selected.length > 1500 ? ` — about ${minutes} min for a selection this long` : "";

  const output = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification,
      title: `LAITA: ${instruction || fallback}${note}`, cancellable: true },
    async (_p, cancel) => {
      const controller = new AbortController();
      cancel.onCancellationRequested(() => controller.abort());
      const timer = setTimeout(() => controller.abort(),
                               core.transformTimeoutMs(selected.length, s));
      try {
        return await core.requestTransform({
          text: selected, instruction: instruction || fallback,
          lang: languageFor(selected), settings: s, signal: controller.signal
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          vscode.window.showErrorMessage("LAITA: " + core.describeError(err).error);
        }
        return null;
      } finally {
        clearTimeout(timer);
      }
    });
  if (!output) return;

  const choice = await vscode.window.showInformationMessage(
    output.length > 300 ? output.slice(0, 300) + "…" : output,
    { modal: true, detail: "Replace the selection with this, or insert it after?" },
    "Replace", "Insert after");
  if (!choice) return;

  await ed.edit((e) => {
    if (choice === "Replace") {
      const lead = selected.match(/^\s*/)[0], trail = selected.match(/\s*$/)[0];
      e.replace(ed.selection, lead + output.trim() + trail);
    } else {
      const sep = /\s$/.test(selected) || /^\s/.test(output) ? ""
                : /\n/.test(selected) || /\n/.test(output) ? "\n\n" : " ";
      e.insert(ed.selection.end, sep + output);
    }
  });
}

// ---------------------------------------------------------------- as you type

/** Files of an unlisted type that the user opted in with "Also check this file". */
const optedIn = new Set();

/**
 * Move diagnostics with the text.
 *
 * A DiagnosticCollection range is a fixed pair of offsets; VS Code does not adjust it
 * when the document changes. Edit one paragraph and every suggestion after it is
 * silently pointing a few characters off, and applying one then corrupts the text -
 * "Finally the" became "FiFinally, theegative" that way. The browser extension
 * re-anchors after every keystroke for the same reason.
 *
 * A diagnostic the edit overlapped is dropped rather than guessed at: the text it
 * described no longer exists.
 */
function shiftDiagnostics(doc, changes) {
  const existing = diagnostics.get(doc.uri);
  if (!existing || !existing.length) return;

  let list = existing;
  for (const ch of changes) {
    const from = ch.rangeOffset;
    const to = ch.rangeOffset + ch.rangeLength;
    const delta = ch.text.length - ch.rangeLength;
    list = list.flatMap((d) => {
      const a = doc.offsetAt(d.range.start), b = doc.offsetAt(d.range.end);
      if (b <= from) return [d];                       // before the edit: unaffected
      if (a >= to) {                                   // after it: slides by delta
        const moved = new vscode.Diagnostic(
          new vscode.Range(doc.positionAt(a + delta), doc.positionAt(b + delta)),
          d.message, d.severity);
        moved.source = d.source;
        moved.code = d.code;
        const issue = fixes.get(d);
        if (issue) fixes.set(moved, issue);
        return [moved];
      }
      return [];                                       // the edit went through it
    });
  }
  diagnostics.set(doc.uri, list);
}

/**
 * The range that really holds `original`, or null.
 *
 * Usually `range` itself. If the text moved, look for it nearby, the way the browser
 * extension re-anchors a suggestion whose span no longer holds its own text. If it
 * cannot be found, the suggestion is no longer applicable and no fix is offered.
 */
function locateIssue(doc, range, original) {
  if (doc.getText(range) === original) return range;

  const full = doc.getText();
  const at = doc.offsetAt(range.start);
  let i = full.indexOf(original, Math.max(0, at - 200));
  if (i === -1 || i > at + 200) i = full.indexOf(original);
  if (i === -1) return null;
  return new vscode.Range(doc.positionAt(i), doc.positionAt(i + original.length));
}

/**
 * Where an anchored issue belongs in the document *now*.
 *
 * The offsets came back from a model that saw the text several seconds ago, and the
 * user has very likely typed since. Mapping them straight onto the current document
 * puts the squiggle in the wrong place, and if the document has become shorter
 * `positionAt` clamps the end, so the underline covers part of the phrase - which is how
 * "too well english" came to be underlined under "too" alone, with the full message
 * attached. The browser extension re-anchors against the current text before painting
 * for exactly this reason.
 */
function rangeForIssue(doc, offset, issue) {
  const naive = new vscode.Range(doc.positionAt(offset + issue.start),
                                 doc.positionAt(offset + issue.end));
  return locateIssue(doc, naive, issue.original);
}

/** Is this a document the user wants proofread without asking? */
function watched(doc) {
  const c = vscode.workspace.getConfiguration("laita");
  if (!c.get("checkOnType")) return false;
  return (c.get("languages") || []).includes(doc.languageId) ||
         optedIn.has(doc.uri.toString());
}

/**
 * Check the paragraph being edited, once the typing stops.
 *
 * Scoped to one paragraph for the same reason the browser extension is: opening a long
 * document and checking all of it queues one slow request per paragraph before the user
 * has written anything. Unchanged paragraphs are skipped so that moving the cursor, or
 * editing elsewhere and coming back, does not re-send text the model has already seen.
 */
function scheduleCheck(doc, line, { orFirstProse = false } = {}) {
  // An untrusted workspace gets commands only, never an automatic check. Opening a folder
  // is not consent to have its contents sent anywhere, and package.json declares exactly
  // this behaviour under capabilities.untrustedWorkspaces.
  if (!vscode.workspace.isTrusted) return;
  if (!watched(doc)) return;
  const key = doc.uri.toString();
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(async () => {
    pending.delete(key);
    if (doc.isClosed) return;
    const lines = doc.getText().split(/\r?\n/);
    const textOf = (q) =>
      doc.getText(new vscode.Range(q.start, 0, q.end, doc.lineAt(q.end).text.length));

    // On open the cursor is usually on line 0, which in most documents is the title:
    // too short to be worth checking, so nothing would happen and the extension would
    // look broken. Fall back to the first paragraph that is actually prose.
    let p = paragraphAt(lines, line);
    if (orFirstProse && (!p || !isProse(textOf(p), p.code))) {
      p = paragraphs(lines).find((q) => isProse(textOf(q), q.code)) || null;
    }
    if (!p) return;
    const text = textOf(p);
    if (lastSent.get(key) === text) return;
    lastSent.set(key, text);
    await run(doc, [p], "checking this paragraph",
              doc.offsetAt(new vscode.Position(line, 0)));
  }, vscode.workspace.getConfiguration("laita").get("debounceMs") || 1500));
}

// ---------------------------------------------------------------- quick fixes

/**
 * Quick fixes.
 *
 * Every title says LAITA. The lightbulb menu pools actions from every extension that
 * has something to say about a diagnostic - VS Code's own "View Problem", and any AI
 * assistant offering to fix it - and without a name on them there is no way to tell
 * whose is whose. Ours are also marked preferred, so `Ctrl+.` then Enter applies the
 * suggestion rather than opening somebody else's chat.
 */
const codeActions = {
  provideCodeActions(doc, range, context) {
    const out = [];
    for (const d of context.diagnostics) {
      const issue = fixes.get(d);
      if (!issue) continue;

      // Last line of defence: only replace text that still reads exactly as the model
      // saw it. Shifting handles the common case, but a reload, an undo, or an edit
      // from another source can still leave a range pointing at the wrong characters,
      // and replacing those corrupts the document.
      const where = locateIssue(doc, d.range, issue.original);
      if (where) {
        const fix = new vscode.CodeAction(`LAITA: change to "${issue.replacement}"`,
                                          vscode.CodeActionKind.QuickFix);
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.replace(doc.uri, where, issue.replacement);
        fix.diagnostics = [d];
        fix.isPreferred = true;
        out.push(fix);
      }

      // Only offer the dictionary for something that is actually a word.
      if (/^[\p{L}\p{M}'-]{2,40}$/u.test(issue.original)) {
        const dict = new vscode.CodeAction(`LAITA: add "${issue.original}" to the dictionary`,
                                           vscode.CodeActionKind.QuickFix);
        dict.command = { command: "laita.addToDictionary", title: "Add to dictionary",
                         arguments: [issue.original, doc.uri, d.range] };
        dict.diagnostics = [d];
        out.push(dict);
      }

      const never = new vscode.CodeAction("LAITA: never make this suggestion again",
                                          vscode.CodeActionKind.QuickFix);
      never.command = { command: "laita.neverSuggest", title: "Never suggest",
                        arguments: [issue.fp, doc.uri, d.range] };
      never.diagnostics = [d];
      out.push(never);

      const dismiss = new vscode.CodeAction("LAITA: dismiss this one for this session",
                                            vscode.CodeActionKind.QuickFix);
      dismiss.command = { command: "laita.dismiss", title: "Dismiss",
                          arguments: [doc.uri, d.range] };
      dismiss.diagnostics = [d];
      out.push(dismiss);
    }
    return out;
  }
};

// ---------------------------------------------------------------- plumbing

/** Drop one diagnostic without re-running the model. */
function removeDiagnostic(uri, range) {
  const left = (diagnostics.get(uri) || []).filter((d) => !d.range.isEqual(range));
  diagnostics.set(uri, left);
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.toString() === uri.toString()) refreshStatus(ed.document);
}

/**
 * Append to a list setting, globally rather than per workspace: a personal dictionary
 * and "never suggest this" are about the person, not the project.
 */
async function appendToSetting(key, value) {
  const c = vscode.workspace.getConfiguration("laita");
  // inspect().globalValue, not get(): get() returns the MERGED value, so a workspace that
  // ships its own laita.dictionary or laita.ignored would have those entries copied into
  // the user's global settings the first time they add a word - and they would outlive the
  // workspace. Only ever grow the user's own list.
  const current = c.inspect(key)?.globalValue || [];
  if (current.includes(value)) return;
  await c.update(key, [...current, value].slice(-500), vscode.ConfigurationTarget.Global);
}

/** Remove one entry from a list setting. */
async function removeFromSetting(key, value) {
  const c = vscode.workspace.getConfiguration("laita");
  await c.update(key, (c.get(key) || []).filter((v) => v !== value),
                 vscode.ConfigurationTarget.Global);
}

/**
 * Show the personal dictionary as a list you can act on.
 *
 * It is an ordinary setting, so it is also visible under Settings and editable in
 * settings.json - but a word gets into it from a lightbulb, and expecting someone to go
 * hunting through Settings to take it back out again is not reasonable.
 */
async function showDictionary() {
  const trash = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Remove from dictionary" };
  const pick = vscode.window.createQuickPick();
  pick.title = "LAITA: personal dictionary";
  pick.placeholder = "Type to filter, or pick the first entry to add a word";

  const refill = () => {
    const words = [...(vscode.workspace.getConfiguration("laita").get("dictionary") || [])].sort();
    pick.items = [
      { label: "$(add) Add a word…", alwaysShow: true },
      ...words.map((w) => ({ label: w, buttons: [trash] }))
    ];
    pick.title = `LAITA: personal dictionary (${words.length} word${words.length === 1 ? "" : "s"})`;
  };
  refill();

  pick.onDidTriggerItemButton(async (e) => {
    await removeFromSetting("dictionary", e.item.label);
    refill();
  });
  pick.onDidAccept(async () => {
    const chosen = pick.selectedItems[0];
    if (!chosen) return;
    if (!chosen.label.startsWith("$(add)")) return;      // a word: nothing to do but look
    pick.hide();
    const word = (await vscode.window.showInputBox({
      title: "LAITA: add a word to the dictionary",
      prompt: "This word will never be flagged again",
      validateInput: (v) => (v.trim() ? null : "Enter a word")
    }))?.trim();
    if (word) {
      await appendToSetting("dictionary", word);
      vscode.window.setStatusBarMessage(`LAITA: "${word}" added`, 3000);
    }
  });
  pick.onDidHide(() => pick.dispose());
  pick.show();
}

function refreshStatus(doc) {
  const n = (diagnostics.get(doc.uri) || []).length;
  status.text = n ? `$(pencil) LAITA: ${n}` : "$(pencil) LAITA";
  status.tooltip = n ? `${n} suggestion${n === 1 ? "" : "s"} in this file` : "No suggestions";
  status.show();
}

async function activate(context) {
  core = await import("../core/ollama.js");
  const anchor = await import("../core/anchor.js");
  core = { ...core, ...anchor };

  diagnostics = vscode.languages.createDiagnosticCollection("laita");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "laita.showMenu";
  status.text = "$(pencil) LAITA";
  status.show();

  // A selector without a scheme also matches output panels, diff views and debug
  // consoles, and VS Code warns about it. Real files and unsaved buffers only.
  const languages = vscode.workspace.getConfiguration("laita").get("languages") || [];
  const sel = languages.flatMap((language) => [
    { scheme: "file", language },
    { scheme: "untitled", language }
  ]);

  context.subscriptions.push(
    diagnostics, status,
    vscode.commands.registerCommand("laita.checkParagraph", checkParagraph),
    vscode.commands.registerCommand("laita.checkDocument", checkDocument),
    vscode.commands.registerCommand("laita.transform", transform),
    vscode.commands.registerCommand("laita.clearDiagnostics", () => {
      diagnostics.clear();
      if (vscode.window.activeTextEditor) refreshStatus(vscode.window.activeTextEditor.document);
    }),
    vscode.commands.registerCommand("laita.dismiss", removeDiagnostic),
    vscode.commands.registerCommand("laita.addToDictionary", async (word, uri, range) => {
      await appendToSetting("dictionary", word);
      removeDiagnostic(uri, range);
      vscode.window.setStatusBarMessage(`LAITA: "${word}" added to the dictionary`, 3000);
    }),
    vscode.commands.registerCommand("laita.neverSuggest", async (fp, uri, range) => {
      if (fp) await appendToSetting("ignored", fp);
      removeDiagnostic(uri, range);
      vscode.window.setStatusBarMessage("LAITA: that suggestion will not come back", 3000);
    }),
    vscode.commands.registerCommand("laita.showDictionary", showDictionary),
    vscode.commands.registerCommand("laita.showMenu", async () => {
      // The status bar item is the only part of LAITA always on screen, so it is the
      // natural place to reach everything else from.
      const items = [
        { label: "$(check) Proofread this paragraph", cmd: "laita.checkParagraph" },
        { label: "$(checklist) Proofread the whole document", cmd: "laita.checkDocument" },
        { label: "$(wand) Transform the selection…", cmd: "laita.transform" },
        { label: "$(book) Personal dictionary…", cmd: "laita.showDictionary" },
        { label: "$(clear-all) Clear suggestions", cmd: "laita.clearDiagnostics" },
        { label: "$(gear) Settings", cmd: "laita.openSettings" }
      ];
      const chosen = await vscode.window.showQuickPick(items, { title: "LAITA" });
      if (chosen) vscode.commands.executeCommand(chosen.cmd);
    }),
    vscode.commands.registerCommand("laita.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:sylvaticus.laita")),
    vscode.commands.registerCommand("laita.clearIgnored", async () => {
      await vscode.workspace.getConfiguration("laita")
        .update("ignored", [], vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage("LAITA: dismissed suggestions can be made again.");
    }),
    vscode.commands.registerCommand("laita.enableForFile", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const id = ed.document.languageId;
      const listed = (vscode.workspace.getConfiguration("laita").get("languages") || [])
        .includes(id);

      // Telling the user the identifier is the point: it is not the file extension and
      // it is not the name VS Code shows in the status bar, so there is no way to guess
      // it. Offering to add it here means never having to look it up.
      const choice = listed
        ? await vscode.window.showInformationMessage(
            `LAITA already checks "${id}" files.`, "Open settings")
        : await vscode.window.showQuickPick(
            [{ label: "$(file) Just this file, this session", permanent: false },
             { label: `$(check-all) Always check "${id}" files`, permanent: true,
               description: "adds it to laita.languages" }],
            { title: `This file's language id is "${id}"` });

      if (choice?.permanent) await appendToSetting("languages", id);
      if (choice === "Open settings") {
        return vscode.commands.executeCommand("laita.openSettings");
      }
      if (!choice) return;

      optedIn.add(ed.document.uri.toString());
      scheduleCheck(ed.document, ed.selection.active.line, { orFirstProse: true });
    }),
    vscode.languages.registerCodeActionsProvider(
      sel.length ? sel : [{ scheme: "file" }, { scheme: "untitled" }], codeActions,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges.length) return;
      shiftDiagnostics(e.document, e.contentChanges);
      scheduleCheck(e.document, e.contentChanges[e.contentChanges.length - 1].range.start.line);
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) {
        refreshStatus(ed.document);
        scheduleCheck(ed.document, ed.selection.active.line, { orFirstProse: true });
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (vscode.workspace.getConfiguration("laita").get("checkOnSave")) {
        run(doc, paragraphs(doc.getText().split(/\r?\n/)), "checking the document");
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
      clearTimeout(pending.get(doc.uri.toString()));
      pending.delete(doc.uri.toString());
      lastSent.delete(doc.uri.toString());
    })
  );

  // The editor that was already open when the extension started never fires
  // onDidChangeActiveTextEditor, so without this a freshly opened document sits there
  // doing nothing until the first keystroke - which reads as a broken extension.
  const open = vscode.window.activeTextEditor;
  if (open) {
    refreshStatus(open.document);
    scheduleCheck(open.document, open.selection.active.line, { orFirstProse: true });
  }
}

function deactivate() {
  for (const t of pending.values()) clearTimeout(t);
}

module.exports = { activate, deactivate,
  __test: { codeActions, fixes, locateIssue, rangeForIssue } };
