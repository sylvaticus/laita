// compat first, and before settings.js: this page calls `browser` directly, and on
// Chrome that name does not exist until compat.js aliases it onto `chrome`. The
// background module and the content scripts each do their own aliasing; these two
// pages were simply missed.
import "../common/compat.js";
import {
  getSettings, setSettings, siteAllowed, isLoopbackEndpoint, isClearTextEndpoint
} from "../common/settings.js";

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
    $("field").textContent = "Local AI Text Assistant is not running on this page.";
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
  // Ask the page. tab.url is only populated for tabs we hold a host permission for, and
  // the extension no longer asks for one over every site.
  try {
    const res = await browser.tabs.sendMessage(tab.id, { cmd: "hostname" });
    hostname = res?.hostname || "";
  } catch {
    hostname = "";
  }
  if (!hostname) {
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      hostname = "";
    }
  }

  const settings = await getSettings();

  // A non-local endpoint is the one setting that makes "nothing leaves your machine"
  // false, and nothing else in the interface would show it. It is a legitimate choice -
  // a bigger machine on your own network - but it should never be a quiet one.
  if (!isLoopbackEndpoint(settings.endpoint)) {
    const warn = $("remoteEndpoint");
    if (warn) {
      let host = settings.endpoint;
      try {
        host = new URL(settings.endpoint).host;
      } catch {
        /* show the raw string if it will not parse */
      }
      warn.textContent = isClearTextEndpoint(settings.endpoint)
        ? `Sending your text to ${host}, unencrypted`
        : `Sending your text to ${host}`;
      warn.hidden = false;
    }
  }
  $("enabled").checked = settings.enabled;
  $("site").checked = siteAllowed(settings, hostname);
  $("siteLabel").textContent = hostname ? `Enabled on ${hostname}` : "Enabled on this site";
  $("site").disabled = !hostname;

  $("enabled").addEventListener("change", async () => {
    await setSettings({ enabled: $("enabled").checked });
  });

  $("site").addEventListener("change", async () => {
    await browser.runtime.sendMessage({ cmd: "toggleSite", hostname, on: $("site").checked });
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
