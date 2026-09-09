import { getSettings, setSettings, siteAllowed } from "../common/settings.js";

const $ = (id) => document.getElementById(id);
let hostname = "";

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshField(tab) {
  if (!tab) return;
  const res = await browser.tabs.sendMessage(tab.id, { cmd: "getFieldState" }).catch(() => null);
  if (!res) {
    $("field").textContent = "Local AI Spell Checker is not running on this page.";
    return;
  }
  if (!res.hasField) {
    $("field").textContent = "Click into a text field, then press Check.";
    return;
  }
  if (res.error) $("field").textContent = res.error;
  else if (res.busy) $("field").textContent = "Checking…";
  else {
    $("field").textContent =
      `${res.count} suggestion${res.count === 1 ? "" : "s"} in the focused field` +
      (res.lang ? ` (${res.lang})` : "");
  }
}

async function init() {
  const tab = await activeTab();
  try {
    hostname = new URL(tab.url).hostname;
  } catch {
    hostname = "";
  }

  const settings = await getSettings();
  $("enabled").checked = settings.enabled;
  $("site").checked = siteAllowed(settings, hostname);
  $("siteLabel").textContent = hostname ? `Enabled on ${hostname}` : "Enabled on this site";
  $("site").disabled = !hostname;

  $("enabled").addEventListener("change", async () => {
    await setSettings({ enabled: $("enabled").checked });
  });

  $("site").addEventListener("change", async () => {
    await browser.runtime.sendMessage({ cmd: "toggleSite", hostname });
  });

  $("check").addEventListener("click", async () => {
    await browser.tabs.sendMessage(tab.id, { cmd: "checkNow" }).catch(() => null);
    setTimeout(() => refreshField(tab), 400);
  });

  $("options").addEventListener("click", () => {
    browser.runtime.openOptionsPage();
    window.close();
  });

  const probe = await browser.runtime.sendMessage({ cmd: "probe" });
  if (probe?.ok && probe.hasModel) {
    $("dot").className = "dot ok";
    $("status").className = "status";
    $("status").textContent = `${probe.model} on ${probe.endpoint.replace(/^https?:\/\//, "")}`;
  } else {
    $("dot").className = "dot bad";
    $("status").className = "status bad";
    $("status").textContent = probe?.ok
      ? `Model "${probe.model}" is not installed in Ollama.`
      : probe?.error || "Cannot reach Ollama.";
  }

  refreshField(tab);
  setInterval(() => refreshField(tab), 1000);
}

init();
