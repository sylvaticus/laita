/**
 * The privacy invariant, asserted directly.
 *
 * README section 6 promises that password fields, payment fields, one-time codes and
 * "anything whose name suggests a secret" are excluded in code and never read. That was
 * true only for <input> and <textarea>: every contenteditable host returned true before
 * any of the checks ran, so a rich-text field in a banking or wallet UI was read in full.
 * Nothing caught it because isCheckable had no tests at all.
 *
 * Each row below is a field that must never be read. A denylist cannot be complete, so
 * this is a floor, not a ceiling.
 */
import { readFileSync } from "node:fs";

const B = new URL("../../src/content/", import.meta.url).pathname;
globalThis.Node = { ELEMENT_NODE: 1 };
globalThis.window = { getSelection: () => null };
globalThis.document = { createElement: () => ({ style: {} }) };
globalThis.LAITA = {};
eval(readFileSync(B + "textmap.js", "utf8"));

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) pass++;
  else { fail++; console.log(`FAIL ${name}\n  got  ${got}\n  want ${want}`); }
};

/** Minimal element. `attrs` are real attributes; `parent` builds an ancestor chain. */
function el({ tag = "DIV", attrs = {}, contentEditable = false, parent = null,
              disabled = false, readOnly = false } = {}) {
  const node = {
    nodeType: 1,
    tagName: tag,
    isContentEditable: contentEditable,
    disabled, readOnly,
    className: attrs.class || "",
    parentElement: parent,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    // Only the opt-out selector is ever passed to closest(); walk for the two markers.
    closest: (_sel) => {
      for (let n = node; n; n = n.parentElement) {
        if (n.getAttribute("data-laita") === "off") return n;
        if (n.getAttribute("data-locaispell") === "off") return n;
      }
      return null;
    }
  };
  return node;
}

const no = (name, e) => eq(name, LAITA.isCheckable(e), false);
const yes = (name, e) => eq(name, LAITA.isCheckable(e), true);

// --- contenteditable: the hole this file exists for -------------------------------------
no("CE with a secret-sounding class",
   el({ contentEditable: true, attrs: { class: "cvv-entry" } }));
no("CE named recovery-phrase",
   el({ contentEditable: true, attrs: { name: "recovery-phrase" } }));
no("CE for a seed mnemonic",
   el({ contentEditable: true, attrs: { "aria-label": "Wallet mnemonic seed" } }));
no("CE with a password placeholder",
   el({ contentEditable: true, attrs: { placeholder: "Enter your passphrase" } }));
no("CE inside a payment fieldset",
   el({ contentEditable: true,
        parent: el({ attrs: { class: "credit-card-details" } }) }));
no("CE inside a bank-details container two levels up",
   el({ contentEditable: true,
        parent: el({ parent: el({ attrs: { id: "bank-account-form" } }) }) }));
no("CE with one-time-code autocomplete",
   el({ contentEditable: true, attrs: { autocomplete: "one-time-code" } }));
no("CE marked aria-hidden",
   el({ contentEditable: true, attrs: { "aria-hidden": "true" } }));
no("CE under data-laita=off",
   el({ contentEditable: true, parent: el({ attrs: { "data-laita": "off" } }) }));

// --- inputs and textareas: these already worked, and must keep working -------------------
no("input type=password", el({ tag: "INPUT", attrs: { type: "password" } }));
no("input type=email", el({ tag: "INPUT", attrs: { type: "email" } }));
no("input named cvv", el({ tag: "INPUT", attrs: { type: "text", name: "cvv" } }));
no("input with cc- autocomplete",
   el({ tag: "INPUT", attrs: { type: "text", autocomplete: "cc-number" } }));
no("textarea named api-token", el({ tag: "TEXTAREA", attrs: { name: "api-token" } }));
no("textarea inside a medical form",
   el({ tag: "TEXTAREA", parent: el({ attrs: { class: "patient-diagnosis" } }) }));
no("disabled textarea", el({ tag: "TEXTAREA", disabled: true }));
no("readonly textarea", el({ tag: "TEXTAREA", readOnly: true }));
no("a plain div is not a field", el({ tag: "DIV" }));
no("not an element", { nodeType: 3 });
no("null", null);

// --- and the ordinary prose fields must still be checkable -------------------------------
yes("a bare textarea", el({ tag: "TEXTAREA" }));
yes("a comment box", el({ tag: "TEXTAREA", attrs: { name: "comment", id: "post-body" } }));
yes("input type=text", el({ tag: "INPUT", attrs: { type: "text", name: "title" } }));
yes("an ordinary rich-text editor", el({ contentEditable: true, attrs: { class: "editor-body" } }));
yes("a CE inside an article", el({ contentEditable: true, parent: el({ attrs: { class: "article" } }) }));

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
