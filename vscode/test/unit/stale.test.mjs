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
               onDidCloseTextDocument: () => ({ dispose() {} }),
               onDidChangeConfiguration: () => ({ dispose() {} }),
               textDocuments: [],
               registerTextDocumentContentProvider: () => ({ dispose() {} }) },
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

// ---------------------------------------------------------------- painting
// The same staleness hits when the squiggle is drawn, not just when the fix is applied.
// A model answer arrives seconds later; if the document shrank meanwhile, mapping the
// offsets straight on clamps the end and underlines part of the phrase - reported as
// "too well english" underlined under "too", with the whole message attached.

const PHRASE = "Sorry, me don't speak too well english.";
const issue2 = { original: "too well english", replacement: "very well English",
                 type: "rephrase", message: "…", fp: "x2", start: 22, end: 38 };
const cover = (doc, off, iss) => {
  const r = ext.__test.rangeForIssue(doc, off, iss);
  return r ? doc.getText(r) : null;
};

eq("unchanged document: the whole phrase", cover(new Doc(PHRASE), 0, issue2), "too well english");

// four characters deleted before the phrase, so offset 22 now lands mid-word and the
// end would clamp
const shorter = new Doc(PHRASE.replace("Sorry, ", "Oh, "));
eq("after a deletion the phrase is found again", cover(shorter, 0, issue2), "too well english");

// text added before it
const longer = new Doc(PHRASE.replace("Sorry,", "Well, sorry,"));
eq("after an insertion too", cover(longer, 0, issue2), "too well english");

// the document shrank past the end of the issue: nothing to underline
const vanished = new Doc("Sorry, me don't speak");
eq("nothing is drawn when the phrase has gone", cover(vanished, 0, issue2), null);

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
