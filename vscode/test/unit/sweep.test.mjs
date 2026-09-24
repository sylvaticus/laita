/**
 * Checking the whole document, and stopping it.
 *
 * Two guarantees, both broken before and neither visible to a unit test of the pieces:
 *
 *  - Stopping a whole-document check keeps the suggestions of every paragraph it had not
 *    reached yet. It used to drop them all up front and repaint as it went, so stopping
 *    halfway wiped the rest of the document's suggestions.
 *  - The request timeout applies to each request, not to the whole run. One timer for
 *    the run ended a long document's check after requestTimeoutMs, silently, because an
 *    abort is not reported as an error.
 *
 * The real extension runs against a stubbed `vscode` and a fake model; the anchoring,
 * the paragraph splitting and run() itself are the shipped code.
 */
import { createRequire } from "node:module";
import Module from "node:module";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; console.log("FAIL " + n + (d ? "\n  " + d : "")); } };

// --- a line-aware document, enough for paragraphs(), ranges and offsets ---------------
class Pos { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Pos) { this.start = a; this.end = b; }
    else { this.start = new Pos(a, b); this.end = new Pos(c, d); }
  }
}
class Doc {
  constructor(text) {
    this.text = text;
    this.lines = text.split("\n");
    this.uri = { toString: () => "file:///sweep.md" };
    this.languageId = "markdown";
  }
  offsetAt(p) {
    let o = 0;
    for (let i = 0; i < p.line; i++) o += this.lines[i].length + 1;
    return o + p.character;
  }
  positionAt(o) {
    let line = 0;
    while (line < this.lines.length - 1 && o > this.lines[line].length) {
      o -= this.lines[line].length + 1;
      line++;
    }
    return new Pos(line, o);
  }
  getText(r) { return r ? this.text.slice(this.offsetAt(r.start), this.offsetAt(r.end)) : this.text; }
  lineAt(i) { return { text: this.lines[i] }; }
}

const store = new Map();                                // the DiagnosticCollection
const config = {
  checkOnType: true, languages: ["markdown"], requestTimeoutMs: 90000, maxChars: 12000,
  chunkMaxChars: 700, dictionary: [], ignored: [], extraInstructions: "", language: "en",
  model: "m", temperature: 0, "categories.error": true, "categories.style": true,
  "categories.rephrase": true, "severity.error": "warning", cacheMax: 100
};
const vscodeStub = {
  Range, Position: Pos,
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  CodeAction: class {}, WorkspaceEdit: class {}, ThemeIcon: class {},
  CodeActionKind: { QuickFix: "quickfix" },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1, Workspace: 2 },
  ProgressLocation: { Window: 10, Notification: 15 },
  window: {
    createStatusBarItem: () => ({ show() {}, dispose() {} }), createQuickPick: () => ({}),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }), activeTextEditor: undefined,
    setStatusBarMessage: () => ({ dispose() {} }), showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined, showInformationMessage: async () => undefined,
    withProgress: async (_o, f) => f({ report() {} }, { onCancellationRequested() {} })
  },
  workspace: {
    isTrusted: true, textDocuments: [],
    getConfiguration: () => ({ get: (k) => config[k], inspect: () => ({}), update: async () => {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }), onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: () => ({ dispose() {} })
  },
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri, list) => store.set(uri.toString(), list), get: (uri) => store.get(uri.toString()),
      delete() {}, clear() {}, dispose() {}
    }),
    registerCodeActionsProvider: () => ({ dispose() {} })
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} }
};
const load = Module._load;
Module._load = (req, p, m) => (req === "vscode" ? vscodeStub : load(req, p, m));
const ext = createRequire(import.meta.url)("../../src/extension.js");
await ext.activate({ subscriptions: [] });
const T = ext.__test;

// --- three paragraphs, each with one mistake the fake model reports -----------------
const P = [
  "The first paragraph has a mistaek in the middle of it.",
  "The second paragraph also has one errror in it, sadly.",
  "The third paragraph ends with a typpo near the end."
];
const WRONG = { 0: "mistaek", 1: "errror", 2: "typpo" };
const doc = new Doc(P.join("\n\n"));
const answer = (i) => [{ original: WRONG[i], replacement: "x", type: "error", message: "spelling" }];
const which = (text) => P.findIndex((p) => text.includes(p.slice(4, 30)));
const covers = (word) => (store.get(doc.uri.toString()) || [])
  .some((d) => doc.getText(d.range) === word);

// ---------------------------------------------------------------- 1. stop halfway
// The third paragraph was checked before: its suggestion is already on screen.
const third = new vscodeStub.Diagnostic(
  new Range(doc.positionAt(doc.text.indexOf("typpo")),
            doc.positionAt(doc.text.indexOf("typpo") + 5)), "old", 1);
store.set(doc.uri.toString(), [third]);

T.useModel(({ text, signal }) => {
  const i = which(text);
  if (i === 0) return Promise.resolve(answer(0));
  // The second one never answers on its own: only the stop ends it.
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
});
const running = T.checkDocument(doc);
await new Promise((r) => setTimeout(r, 30));
ok("a whole-document check is running", T.isChecking());
ok("...and has painted the first paragraph as it went", covers("mistaek"));
T.stopDocument();
await running;
ok("stopping ends it", !T.isChecking());
ok("the first paragraph keeps what was just found", covers("mistaek"));
ok("the paragraph it never reached keeps its old suggestion", covers("typpo"),
   JSON.stringify((store.get(doc.uri.toString()) || []).map((d) => doc.getText(d.range))));

// ---------------------------------------------------------------- 2. timeout per request
// Each answer takes 40 ms against a 60 ms timeout: every request is within it, the run as
// a whole is not. One timer for the run stopped after the first paragraph or two.
store.clear();
config.requestTimeoutMs = 60;
config.model = "another";              // a different cache key: nothing may come from test 1
// Like fetch: an aborted request rejects. A fake that ignored the signal let the old
// one-timer-per-run code pass this test, because its abort then changed nothing.
T.useModel(({ text, signal }) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(answer(which(text))), 40);
  signal.addEventListener("abort", () => {
    clearTimeout(t);
    reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  });
}));
await T.checkDocument(doc);
ok("every paragraph is checked though the run outlasts one timeout",
   covers("mistaek") && covers("errror") && covers("typpo"),
   JSON.stringify((store.get(doc.uri.toString()) || []).map((d) => doc.getText(d.range))));
ok("...and the check is over afterwards", !T.isChecking());

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
