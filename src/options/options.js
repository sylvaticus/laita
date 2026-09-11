import { DEFAULTS, getSettings, setSettings } from "../common/settings.js";

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
    document.createTextNode(allow ? "Sites where Local AI Spell Checker runs " : "Sites where Local AI Spell Checker stays quiet "),
    hint
  );
}

function collect() {
  const patch = {};
  for (const [id, kind] of SCALARS) {
    const el = $(id);
    if (kind === "bool") patch[id] = el.checked;
    else if (kind === "number") {
      const n = Number(el.value);
      patch[id] = Number.isFinite(n) ? n : DEFAULTS[id];
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

async function save() {
  settings = await setSettings(collect());
  flashSaved();
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

  for (const [id] of SCALARS) {
    $(id).addEventListener("change", scheduleSave);
    $(id).addEventListener("input", scheduleSave);
  }
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
    if (!confirm("Reset every Local AI Spell Checker setting to its default?")) return;
    await browser.storage.local.clear();
    settings = await getSettings();
    fill();
    flashSaved();
  });

  probe();
}

init();
