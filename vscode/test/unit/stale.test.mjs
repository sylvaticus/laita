/**
 * A quick fix must never replace text other than the text the model was shown.
 *
 * This is the bug that corrupted a document: the check ran, the user edited earlier in
 * the file, and the diagnostic's range - which VS Code does not move - then pointed two
 * characters off. Applying it turned "Finally the negative" into "FiFinally, theegative".
 */
import { createRequire } from "node:module";
import Module from "node:module";

let pass = 0, fail = 0;
const eq = (n, g, w) => {
  const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) pass++; else { fail++; console.log("FAIL " + n + "\n  got  " + a + "\n  want " + b); }
};

// --- the smallest TextDocument that offsetAt/positionAt/getText need ---------------
class Doc {
  constructor(text) { this.text = text; this.uri = { toString: () => "file:///t.md" }; }
  getText(r) { return r ? this.text.slice(r._a, r._b) : this.text; }
  offsetAt(p) { return p._o; }
  positionAt(o) { return { _o: o }; }
  lineAt() { return { text: "" }; }
}
const R = (a, b) => ({ _a: a, _b: b, start: { _o: a }, end: { _o: b },
                       isEqual(o) { return o._a === a && o._b === b; } });

const vscodeStub = {
  Range: function (s, e) { return R(s._o ?? s, e._o ?? e); },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  CodeAction: class { constructor(title, kind) { Object.assign(this, { title, kind }); } },
  WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ range, text }); } },
  CodeActionKind: { QuickFix: "quickfix" },
  DiagnosticSeverity: { Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Window: 10, Notification: 15 },
  ThemeIcon: class {},
  window: { createStatusBarItem: () => ({ show() {}, dispose() {} }), createQuickPick: () => ({}),
            onDidChangeActiveTextEditor: () => ({ dispose() {} }), activeTextEditor: undefined,
            setStatusBarMessage: () => ({ dispose() {} }), showQuickPick: async () => undefined,
            showInformationMessage: async () => undefined, showInputBox: async () => undefined,
            showWarningMessage: async () => undefined, showErrorMessage: async () => undefined,
            withProgress: async (_o, f) => f({ report() {} }, { onCancellationRequested() {} }) },
  workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => {} }),
               onDidChangeTextDocument: () => ({ dispose() {} }),
               onDidSaveTextDocument: () => ({ dispose() {} }),
               onDidCloseTextDocument: () => ({ dispose() {} }) },
  languages: { createDiagnosticCollection: () => ({ set() {}, get: () => [], delete() {}, clear() {}, dispose() {} }),
               registerCodeActionsProvider: () => ({ dispose() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} }
};
const load = Module._load;
Module._load = (req, p, m) => (req === "vscode" ? vscodeStub : load(req, p, m));

const ext = createRequire(import.meta.url)("../../src/extension.js");
await ext.activate({ subscriptions: [] });

// ---------------------------------------------------------------- the scenario
const TEXT = "In any finite system there must be constraints. " +
             "Finally the negative loops balance or dominate the positive ones.";
const AT = TEXT.indexOf("Finally the");
const issue = { original: "Finally the", replacement: "Finally, the", type: "error",
                message: "comma", fp: "x1" };

const actionsFor = (doc, range) => {
  const d = new vscodeStub.Diagnostic(range, "comma", 1);
  ext.__test.fixes.set(d, issue);
  return ext.__test.codeActions.provideCodeActions(doc, range, { diagnostics: [d] });
};
const applied = (doc, acts) => {
  const fix = acts.find((a) => a.title.startsWith("LAITA: change to"));
  if (!fix) return null;
  const e = fix.edit.edits[0];
  return doc.text.slice(0, e.range._a) + e.text + doc.text.slice(e.range._b);
};

// the range is right: the fix applies where it should
const good = new Doc(TEXT);
eq("correct range replaces the right words", applied(good, actionsFor(good, R(AT, AT + 11))),
   TEXT.replace("Finally the", "Finally, the"));

// two characters were deleted earlier, so the stored range now points two chars late.
// This is the exact shape of the reported corruption.
const edited = new Doc(TEXT.replace("In any finite", "In a finite"));
const stale = R(AT, AT + 11);              // unchanged, as VS Code would leave it
const out = applied(edited, actionsFor(edited, stale));
eq("a stale range is relocated, not applied blindly",
   out, edited.text.replace("Finally the", "Finally, the"));
eq("and it never produces the reported corruption", /FiFinally|theegative/.test(out || ""), false);

// the words are gone entirely: no fix should be offered at all
const gone = new Doc(TEXT.replace("Finally the negative", "Lastly the negative"));
eq("no fix when the text no longer exists",
   actionsFor(gone, R(AT, AT + 11)).some((a) => a.title.startsWith("LAITA: change to")), false);

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
