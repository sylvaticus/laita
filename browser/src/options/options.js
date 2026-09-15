// compat first, and before settings.js: this page calls `browser` directly, and on
// Chrome that name does not exist until compat.js aliases it onto `chrome`. The
// background module and the content scripts each do their own aliasing; these two
// pages were simply missed.
import "../common/compat.js";
import {
  DEFAULTS, getSettings, setSettings, isLoopbackEndpoint, isClearTextEndpoint,
  clampSetting, LIMITS
} from "../common/settings.js";

const $ = (id) => document.getElementById(id);

/** Plain scalar fields: element id === settings key. */
const SCALARS = [
  ["endpoint", "text"], ["model", "text"], ["temperature", "number"], ["numCtx", "number"],
  ["concurrency", "number"], ["keepAlive", "text"], ["think", "bool"],
  ["triggerMode", "text"], ["checkScope", "text"], ["debounceMs", "number"], ["minChars", "number"],
  ["chunkMaxChars", "number"], ["maxChars", "number"], ["language", "text"],
  ["tint", "bool"], ["showBadge", "bool"], ["siteMode", "text"],
  ["enabled", "bool"], ["debug", "bool"], ["extraInstructions", "text"],
  ["transformDefault", "text"]
];

let settings = null;
let saveTimer = null;

function toLines(list) {
  return (list || []).join("\n");
}
function fromLines(text) {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

function fill() {
  for (const [id, kind] of SCALARS) {
    const el = $(id);
    if (kind === "bool") el.checked = !!settings[id];
    else el.value = settings[id];
  }
  for (const el of document.querySelectorAll("[data-cat]")) {
    el.checked = !!settings.categories[el.dataset.cat];
  }
  for (const el of document.querySelectorAll("[data-color]")) {
    el.value = settings.colors[el.dataset.color];
  }
  $("dictionary").value = toLines(settings.dictionary);
  $("transformHistory").value = toLines(settings.transformHistory);
  $("siteList").value = toLines(
    settings.siteMode === "allowlist" ? settings.enabledSites : settings.disabledSites
  );
  $("ignoredCount").textContent = settings.ignored.length;
  $("overrideCount").textContent = Object.keys(settings.siteOverrides || {}).length;
  syncSiteLabel();
}

function syncSiteLabel() {
  const allow = $("siteMode").value === "allowlist";
  const hint = document.createElement("small");
  hint.textContent = "(one hostname per line)";
  $("siteListLabel").replaceChildren(
    document.createTextNode(allow ? "Sites where Local AI Text Assistant runs " : "Sites where Local AI Text Assistant stays quiet "),
    hint
  );
}

/** Say what was changed and why, next to the field it happened to. */
function noteAdjusted(id, typed, used) {
  const row = $(id)?.closest(".row");
  if (!row) return;
  let note = row.querySelector(".adjusted");
  if (!note) {
    note = document.createElement("p");
    note.className = "adjusted";
    row.appendChild(note);
  }
  const range = LIMITS[id];
  note.textContent = range
    ? `"${typed}" is outside ${range[0]}\u2013${range[1]}; using ${used}.`
    : `"${typed}" is not a number; using ${used}.`;
  clearTimeout(note._t);
  note._t = setTimeout(() => note.remove(), 6000);
}

function collect() {
  const patch = {};
  for (const [id, kind] of SCALARS) {
    const el = $(id);
    if (kind === "bool") patch[id] = el.checked;
    else if (kind === "number") {
      // Anything out of range is pulled back into it rather than accepted: concurrency 100
      // against a server that serialises, debounceMs 0 (a request per keystroke) and a
      // negative temperature were all taken without comment. And a value that is silently
      // rewritten has to say so, or the field just appears to eat what you typed.
      const before = el.value.trim();
      const after = clampSetting(id, before === "" ? DEFAULTS[id] : before);
      patch[id] = after;
      if (before !== "" && String(after) !== before) noteAdjusted(id, before, after);
      el.value = after;
    } else patch[id] = el.value;
  }
  patch.categories = {};
  for (const el of document.querySelectorAll("[data-cat]")) patch.categories[el.dataset.cat] = el.checked;
  patch.colors = {};
  for (const el of document.querySelectorAll("[data-color]")) patch.colors[el.dataset.color] = el.value;
  patch.dictionary = fromLines($("dictionary").value);
  patch.siteOverrides = settings.siteOverrides;
  patch.transformHistory = fromLines($("transformHistory").value).slice(0, 20);

  const sites = fromLines($("siteList").value).map((h) => h.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  if (patch.siteMode === "allowlist") {
    patch.enabledSites = sites;
    patch.disabledSites = settings.disabledSites;
  } else {
    patch.disabledSites = sites;
    patch.enabledSites = settings.enabledSites;
  }
  return patch;
}

function flashSaved() {
  const el = $("saved");
  el.classList.add("on");
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => el.classList.remove("on"), 1100);
}

/**
 * Sending your text somewhere other than this machine is a decision, not a typo.
 *
 * The endpoint is free text and the extension's headline promise is that nothing leaves
 * the machine. Before a non-loopback endpoint takes effect the user is asked, by name, and
 * the host permission needed to reach it is requested there and then - so the choice also
 * appears in the browser's own permission UI rather than only in ours. Declining restores
 * the previous value instead of half-applying the change.
 *
 * Returns the endpoint to actually save.
 */
async function confirmEndpoint(next, previous) {
  if (!next || next === previous || isLoopbackEndpoint(next)) return next;

  let host = next;
  try {
    host = new URL(next).host;
  } catch {
    /* unparseable: show it verbatim, and it is treated as remote either way */
  }
  const clear = isClearTextEndpoint(next)
    ? "\n\nThis address is plain http, so the text will travel unencrypted."
    : "";
  const ok = confirm(
    `"${host}" is not on this computer.\n\n` +
    `Everything LAITA proofreads or rewrites will be sent there, and the promise that ` +
    `nothing leaves your machine no longer applies.${clear}\n\n` +
    `Use this endpoint?`
  );
  if (!ok) {
    $("endpoint").value = previous ?? DEFAULTS.endpoint;
    return previous ?? DEFAULTS.endpoint;
  }

  // Reaching a host we hold no permission for fails silently in fetch, so ask for it here,
  // where there is a user gesture to hang the request off.
  try {
    const origin = new URL(next).origin + "/*";
    const granted = await browser.permissions.request({ origins: [origin] });
    if (!granted) {
      alert(
        `Permission to contact ${host} was not granted, so requests to it would fail.\n\n` +
        `Keeping the previous endpoint.`
      );
      $("endpoint").value = previous ?? DEFAULTS.endpoint;
      return previous ?? DEFAULTS.endpoint;
    }
  } catch {
    /* an unparseable origin cannot be requested; the confirmation above stands */
  }
  return next;
}

async function save() {
  const patch = collect();
  patch.endpoint = await confirmEndpoint(patch.endpoint, settings?.endpoint);
  settings = await setSettings(patch);
  renderEndpointWarning();
  flashSaved();
}

/** A standing marker for as long as the endpoint is not local. */
function renderEndpointWarning() {
  const el = $("endpointWarning");
  if (!el) return;
  const endpoint = $("endpoint").value;
  if (isLoopbackEndpoint(endpoint)) {
    el.hidden = true;
    return;
  }
  let host = endpoint;
  try {
    host = new URL(endpoint).host;
  } catch {
    /* verbatim */
  }
  el.textContent = isClearTextEndpoint(endpoint)
    ? `Your text is sent to ${host}, unencrypted. It does not stay on this machine.`
    : `Your text is sent to ${host}. It does not stay on this machine.`;
  el.hidden = false;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 350);
}

async function probe() {
  const out = $("probe");
  out.className = "status";
  out.textContent = "Contacting Ollama…";
  await save();
  const res = await browser.runtime.sendMessage({ cmd: "probe" });
  if (!res?.ok) {
    out.className = "status bad";
    out.textContent = res?.error || "Could not reach Ollama.";
    return;
  }
  const list = $("model-list");
  list.replaceChildren();
  for (const name of res.models) {
    const opt = document.createElement("option");
    opt.value = name;
    list.appendChild(opt);
  }
  out.className = "status " + (res.hasModel ? "ok" : "bad");
  out.textContent = res.hasModel
    ? `Connected. ${res.models.length} model${res.models.length === 1 ? "" : "s"} available, "${res.model}" is one of them.`
    : `Connected, but "${res.model}" is not installed. Available: ${res.models.join(", ") || "none"}. Run: ollama pull ${res.model}`;
}

async function init() {
  settings = await getSettings();
  fill();
  renderEndpointWarning();

  for (const [id] of SCALARS) {
    $(id).addEventListener("change", scheduleSave);
    // Not the endpoint: saving it can raise a confirmation, and the debounced save fires
    // 350ms after each keystroke - which would interrupt you halfway through typing a
    // hostname. It saves when you leave the field or press Enter, like a form.
    if (id !== "endpoint") $(id).addEventListener("input", scheduleSave);
  }
  $("endpoint").addEventListener("input", renderEndpointWarning);
  for (const el of document.querySelectorAll("[data-cat],[data-color]")) {
    el.addEventListener("change", scheduleSave);
  }
  $("dictionary").addEventListener("input", scheduleSave);
  $("transformHistory").addEventListener("input", scheduleSave);
  $("siteList").addEventListener("input", scheduleSave);

  $("siteMode").addEventListener("change", async () => {
    await save();
    settings = await getSettings();
    fill();
  });

  $("test").addEventListener("click", (e) => {
    e.preventDefault();
    probe();
  });

  $("clearCache").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ cmd: "clearCache" });
    flashSaved();
  });

  $("clearIgnored").addEventListener("click", async () => {
    settings = await setSettings({ ignored: [] });
    $("ignoredCount").textContent = "0";
    flashSaved();
  });

  $("clearOverrides").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ cmd: "clearSiteOverrides" });
    settings = await getSettings();
    $("overrideCount").textContent = "0";
    flashSaved();
  });

  $("reset").addEventListener("click", async () => {
    if (!confirm("Reset every Local AI Text Assistant setting to its default?")) return;
    await browser.storage.local.clear();
    settings = await getSettings();
    fill();
    flashSaved();
  });

  probe();
}

init();
