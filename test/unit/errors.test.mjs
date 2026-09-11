import { readFileSync } from "node:fs";
import { isTransient, describeError } from "../../src/background/ollama.js";

// common.js declares `var LAS`, so it has to be evaluated in the global sloppy scope.
(0, eval)(readFileSync(new URL("../../src/content/common.js", import.meta.url).pathname, "utf8"));
const LAS = globalThis.LAS;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++; else { fail++; console.log("FAIL " + name + "\n  got  " + a + "\n  want " + b); }
};
const err = (message, extra = {}) => Object.assign(new Error(message), extra);
const abort = () => err("The operation was aborted.", { name: "AbortError" });

// ---------------------------------------------------------------- isTransient
// The point of this: a model that failed to load usually loads on the second try, so
// retrying hides a routine reload. Nothing else gets better by repeating it.

eq("500 is worth retrying", isTransient(err("Ollama returned HTTP 500. ")), true);
eq("502 is worth retrying", isTransient(err("Ollama returned HTTP 502.")), true);
eq("503 is worth retrying", isTransient(err("Ollama returned HTTP 503.")), true);
eq("a dropped connection is worth retrying", isTransient(err("NetworkError when attempting to fetch")), true);

eq("403 is not - the origin is refused until configured", isTransient(err("Ollama returned HTTP 403.")), false);
eq("404 is not - the model is simply absent", isTransient(err("Ollama returned HTTP 404.")), false);
eq("our own abort is not", isTransient(abort()), false);
eq("a superseded request is not", isTransient({ stale: true }), false);
eq("a parse failure is not", isTransient(err("Could not parse the model's answer as JSON.")), false);
eq("an empty answer is not", isTransient(err("The model returned an empty answer.")), false);

// ---------------------------------------------------------------- describeError

eq("stale is reported as stale, not as an error", describeError({ stale: true }), { ok: false, stale: true });
eq("abort is a timeout", describeError(abort()).kind, "timeout");
eq("timeout says what to do", /raise the timeout|smaller model/.test(describeError(abort()).error), true);
eq("connection", describeError(err("NetworkError when attempting to fetch")).kind, "connection");
eq("403 is the origin problem", describeError(err("Ollama returned HTTP 403.")).kind, "cors");
eq("404 is the missing model", describeError(err("Ollama returned HTTP 404.")).kind, "model");

// a 500 caused by the runner failing to start is the common real-world case, and the
// message has to name the cause rather than dump Go internals at the user
const load = describeError(err('Ollama returned HTTP 500. {"error":"timed out waiting for llama-server to start"}'));
eq("500 from a failed load is a server error", load.kind, "server");
eq("500 from a failed load explains itself", /does not fit in the GPU/.test(load.error), true);
eq("500 from a failed load hides the Go text", /llama-server to start/.test(load.error), false);

const other500 = describeError(err("Ollama returned HTTP 500. something else entirely"));
eq("an unexplained 500 is still a server error", other500.kind, "server");
eq("an unexplained 500 keeps the detail", /something else entirely/.test(other500.error), true);

eq("anything else falls through", describeError(err("boom")), { ok: false, kind: "other", error: "boom" });

// ---------------------------------------------------------------- delivery failures
// "Receiving end does not exist" has two very different causes, and the advice differs:
// an event page still waking up is worth retrying, an orphaned content script never is.

const K = (msg, orphaned) => LAS.sendFailureKind(msg, orphaned);

eq("no receiver yet is worth one retry", K("Could not establish connection. Receiving end does not exist.", false), "starting");
eq("a disconnected manager is worth one retry", K("Message manager disconnected", false), "starting");
eq("the same message from an orphan is terminal", K("Could not establish connection. Receiving end does not exist.", true), "orphaned");
eq("a dead browser object is terminal", K("can't access dead object", true), "orphaned");
eq("an invalidated context is terminal even if not yet detected", K("Extension context invalidated.", true), "orphaned");
eq("anything else is a real failure", K("handler threw TypeError", false), "other");
eq("an orphan outranks everything", K("handler threw TypeError", true), "orphaned");

// the advice the user is given has to match the cause
LAS.lastSendError = "Could not establish connection. Receiving end does not exist.";
LAS.isOrphaned = () => true;
eq("an orphan is told to reload the page", /reloaded or updated/.test(LAS.sendFailure()), true);
eq("an orphan is not blamed on the background page", /did not answer/.test(LAS.sendFailure()), false);
LAS.isOrphaned = () => false;
eq("otherwise the reason is passed through", /Receiving end does not exist/.test(LAS.sendFailure()), true);

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
