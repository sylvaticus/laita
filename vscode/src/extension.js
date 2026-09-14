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
const { detectLanguage, paragraphs, paragraphAt, isProse } = require("./text.js");

let core = null;                 // { requestIssues, requestTransform, anchorIssues, ... }
let diagnostics;                 // vscode.DiagnosticCollection
let status;                      // vscode.StatusBarItem
/** Diagnostic -> the issue it came from, so a code action can apply the right fix. */
const fixes = new WeakMap();
/** uri -> debounce timer, for checking as you type. */
const pending = new Map();
/** uri -> the paragraph text last sent, so an unchanged paragraph is not re-sent. */
const lastSent = new Map();

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Warning,      // not Error: this is prose, not a build
  style: vscode.DiagnosticSeverity.Information,
  rephrase: vscode.DiagnosticSeverity.Hint
};

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
    ignored: []
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
  const raw = await core.requestIssues({ text, lang, settings: s, signal: token });
  const anchored = core.anchorIssues(text, raw, { categories: s.categories, ignored: [] });

  return anchored.map((issue) => {
    const range = new vscode.Range(doc.positionAt(offset + issue.start),
                                   doc.positionAt(offset + issue.end));
    const d = new vscode.Diagnostic(range, issue.message || "Suggested change",
                                    SEVERITY[issue.type] ?? vscode.DiagnosticSeverity.Information);
    d.source = "LAITA";
    d.code = issue.type;
    fixes.set(d, issue);
    return d;
  });
}

/** Everything the model should look at in `ranges`, as {text, offset} pieces. */
function piecesFor(doc, paras, s) {
  const pieces = [];
  for (const p of paras) {
    const range = new vscode.Range(p.start, 0, p.end, doc.lineAt(p.end).text.length);
    const text = doc.getText(range);
    if (!isProse(text, p.code)) continue;
    pieces.push({ text, offset: doc.offsetAt(range.start) });
  }
  return pieces;
}

async function run(doc, paras, label) {
  if (!core) return;
  const s = settings();
  const pieces = piecesFor(doc, paras, s);
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
  await run(ed.document, [p], "checking this paragraph");
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

/** Is this a document the user wants proofread without asking? */
function watched(doc) {
  const c = vscode.workspace.getConfiguration("laita");
  return c.get("checkOnType") && (c.get("languages") || []).includes(doc.languageId);
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
    await run(doc, [p], "checking this paragraph");
  }, vscode.workspace.getConfiguration("laita").get("debounceMs") || 1500));
}

// ---------------------------------------------------------------- quick fixes

const codeActions = {
  provideCodeActions(doc, range, context) {
    const out = [];
    for (const d of context.diagnostics) {
      const issue = fixes.get(d);
      if (!issue) continue;
      const fix = new vscode.CodeAction(`Change to "${issue.replacement}"`,
                                        vscode.CodeActionKind.QuickFix);
      fix.edit = new vscode.WorkspaceEdit();
      fix.edit.replace(doc.uri, d.range, issue.replacement);
      fix.diagnostics = [d];
      fix.isPreferred = true;
      out.push(fix);

      const ignore = new vscode.CodeAction("Dismiss this suggestion",
                                           vscode.CodeActionKind.QuickFix);
      ignore.command = { command: "laita.dismiss", title: "Dismiss", arguments: [doc.uri, d.range] };
      out.push(ignore);
    }
    return out;
  }
};

// ---------------------------------------------------------------- plumbing

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
  status.command = "laita.checkParagraph";
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
    vscode.commands.registerCommand("laita.dismiss", (uri, range) => {
      const left = (diagnostics.get(uri) || []).filter((d) => !d.range.isEqual(range));
      diagnostics.set(uri, left);
    }),
    vscode.languages.registerCodeActionsProvider(
      sel.length ? sel : [{ scheme: "file" }, { scheme: "untitled" }], codeActions,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges.length) return;
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
  DBG("activate: activeEditor=" + !!vscode.window.activeTextEditor +
    " lang=" + (vscode.window.activeTextEditor?.document.languageId) +
    " watched=" + (vscode.window.activeTextEditor ? watched(vscode.window.activeTextEditor.document) : "n/a"));
  const open = vscode.window.activeTextEditor;
  if (open) {
    refreshStatus(open.document);
    scheduleCheck(open.document, open.selection.active.line, { orFirstProse: true });
  }
}

function deactivate() {
  for (const t of pending.values()) clearTimeout(t);
}

module.exports = { activate, deactivate };
