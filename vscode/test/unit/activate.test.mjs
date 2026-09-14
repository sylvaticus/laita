/**
 * Load the real extension against a stubbed `vscode` and activate it.
 *
 * `node --check` validates syntax, not references, and no other test loads
 * extension.js - it requires the `vscode` module, which only exists inside the
 * extension host. A stray call to a function that no longer exists therefore passed
 * every check and would only have failed on a user's machine, which is exactly what
 * happened once. This catches it.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import Module from "node:module";

const require_ = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; console.log("FAIL " + n + (d ? "\n  " + d : "")); } };

// ---------------------------------------------------------------- the stub
const registered = new Map();
const providers = [];
const listeners = [];
const config = {
  checkOnType: true, languages: ["markdown"], endpoint: "http://localhost:11434",
  model: "m", temperature: 0, numCtx: 0, keepAlive: "10m", think: false,
  requestTimeoutMs: 90000, maxChars: 12000, chunkMaxChars: 700, dictionary: [],
  ignored: [], extraInstructions: "", language: "auto", debounceMs: 1500,
  checkOnSave: false, transformDefault: "polish",
  "categories.error": true, "categories.style": true, "categories.rephrase": true,
  "severity.error": "warning", "severity.style": "info", "severity.rephrase": "info"
};
const disposable = () => ({ dispose() {} });
const event = (name) => (fn) => { listeners.push(name); return disposable(); };

const vscodeStub = {
  window: {
    activeTextEditor: undefined,
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: "", tooltip: "", command: "" }),
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    setStatusBarMessage: () => disposable(),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    withProgress: async (_o, fn) => fn({ report() {} }, { onCancellationRequested() {} }),
    createQuickPick: () => ({
      items: [], title: "", placeholder: "", selectedItems: [],
      onDidTriggerItemButton() {}, onDidAccept() {}, onDidHide() {},
      show() {}, hide() {}, dispose() {}
    }),
    onDidChangeActiveTextEditor: event("onDidChangeActiveTextEditor")
  },
  workspace: {
    getConfiguration: () => ({ get: (k) => config[k], update: async () => {} }),
    onDidChangeTextDocument: event("onDidChangeTextDocument"),
    onDidSaveTextDocument: event("onDidSaveTextDocument"),
    onDidCloseTextDocument: event("onDidCloseTextDocument")
  },
  languages: {
    createDiagnosticCollection: () => ({
      set() {}, get: () => [], delete() {}, clear() {}, dispose() {}
    }),
    registerCodeActionsProvider: (sel, provider) => { providers.push({ sel, provider }); return disposable(); }
  },
  commands: {
    registerCommand: (id, fn) => { registered.set(id, fn); return disposable(); },
    executeCommand: async () => undefined
  },
  Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  CodeAction: class { constructor(title, kind) { Object.assign(this, { title, kind }); } },
  WorkspaceEdit: class { replace() {} },
  StatusBarAlignment: { Right: 2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  CodeActionKind: { QuickFix: "quickfix" },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Window: 10, Notification: 15 },
  ThemeIcon: class { constructor(id) { this.id = id; } }
};

const load = Module._load;
Module._load = (req, parent, isMain) =>
  req === "vscode" ? vscodeStub : load(req, parent, isMain);

// ---------------------------------------------------------------- activate
const ext = require_("../../src/extension.js");
const context = { subscriptions: [] };
let threw = null;
try {
  await ext.activate(context);
} catch (err) {
  threw = err;
}
ok("activate() does not throw", threw === null, threw && (threw.stack || String(threw)));
ok("it registers disposables", context.subscriptions.length > 0);
ok("deactivate() does not throw", (() => { try { ext.deactivate(); return true; } catch { return false; } })());

// ---------------------------------------------------------------- commands line up
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)));
const declared = pkg.contributes.commands.map((c) => c.command);

for (const id of declared) {
  ok(`palette command ${id} is implemented`, registered.has(id));
}
// commands a code action invokes must exist too, or the lightbulb entry does nothing
const src = readFileSync(new URL("../../src/extension.js", import.meta.url), "utf8");
for (const m of src.matchAll(/command: "(laita\.[a-zA-Z]+)"/g)) {
  ok(`code-action command ${m[1]} is implemented`, registered.has(m[1]));
}
// and keybindings must point at something real
for (const k of pkg.contributes.keybindings || []) {
  ok(`keybinding ${k.key} -> ${k.command} is implemented`, registered.has(k.command));
}

ok("a code action provider is registered", providers.length === 1);
ok("its selectors all carry a scheme",
   providers[0].sel.every((x) => typeof x === "object" && x.scheme),
   JSON.stringify(providers[0].sel));
ok("it watches document changes", listeners.includes("onDidChangeTextDocument"));
ok("the status bar leads somewhere real", registered.has("laita.showMenu"));
ok("the shared core exposes the hash the cache key needs",
   typeof (await import("../../core/anchor.js")).hash === "function");
ok("it cleans up on close", listeners.includes("onDidCloseTextDocument"));

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
