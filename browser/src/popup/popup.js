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
/** Whether the focused field's whole-field check is running, as last reported. */
let wholeRunning = false;

const WHOLE_START = "Check the whole field (may take a while…)";
const WHOLE_STOP = "Stop checking the whole field";
const TYPING_ON = "Check as you type";
const TYPING_OFF = "Stop checking as you type";

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** @returns {Promise<boolean>} whether a check is still running, so the caller knows
 *  whether there is any point asking again. */
async function refreshField(tab) {
  if (!tab) return false;
  const res = await browser.tabs.sendMessage(tab.id, { cmd: "getFieldState" }).catch(() => null);
  if (!res) {
    $("field").textContent = "LAITA is not running on this page.";
    return false;
  }
  if (!res.hasField) {
    $("field").textContent = "Click into a text field, then press Check.";
    return false;
  }
  wholeRunning = !!res.whole;
  $("checkLabel").textContent = wholeRunning ? WHOLE_STOP : WHOLE_START;
  if (res.error) $("field").textContent = res.error;
  else if (res.busy) $("field").textContent = "Checking…";
  else {
    $("field").textContent =
      `${res.count} suggestion${res.count === 1 ? "" : "s"} in the focused field` +
      (res.lang ? ` (${res.lang})` : "");
  }
  return !!res.busy;
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

  // Everything the right-click menu offers is here too, because a page can replace its
  // own context menu - Overleaf does - and then the menu simply never appears. The
  // toolbar popup is browser chrome: no page can touch it.
  const transformBtn = $("transform");
  const selectionNote = $("selection");

  const refreshSelection = async () => {
    const res = await browser.tabs
      .sendMessage(tab.id, { cmd: "peekSelection" })
      .catch(() => null);
    if (!res?.ok) {
      transformBtn.disabled = true;
      selectionNote.textContent = "";
      return;
    }
    if (!res.hasSelection) {
      transformBtn.disabled = true;
      selectionNote.textContent = "Select some text on the page to transform it.";
      return;
    }
    transformBtn.disabled = false;
    selectionNote.textContent = res.editable
      ? `${res.chars} characters selected: “${res.preview}”`
      : `${res.chars} characters selected: “${res.preview}” — read-only, so the result ` +
        `can only be copied.`;
  };
  await refreshSelection();

  transformBtn.addEventListener("click", async () => {
    await browser.tabs.sendMessage(tab.id, { cmd: "transformSelection" }).catch(() => null);
    // The panel opens in the page, behind this popup, so get out of its way.
    window.close();
  });

  $("check").addEventListener("click", async () => {
    // Stop only the whole-field check; checking as you type is the other button.
    const cmd = wholeRunning ? "stopWholeCheck" : "checkNow";
    await browser.tabs.sendMessage(tab.id, { cmd }).catch(() => null);
    setTimeout(() => refreshField(tab), 400);
  });

  // The same setting as Trigger in the options; the tabs hear of it like any other change.
  const typingBtn = $("typing");
  const showTyping = (auto) => { typingBtn.textContent = auto ? TYPING_OFF : TYPING_ON; };
  showTyping(settings.triggerMode === "auto");
  typingBtn.addEventListener("click", async () => {
    const auto = (await getSettings()).triggerMode === "auto";
    await setSettings({ triggerMode: auto ? "manual" : "auto" });
    showTyping(!auto);
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

  // Poll only while the popup is on screen and the field is actually busy. The old
  // unconditional 1s timer kept running against a settled field for as long as the popup
  // stayed open, asking a content script the same question forever. A popup closes when it
  // loses focus, so this is small either way - but "small and pointless" is still pointless.
  refreshField(tab);
  let poll = null;
  const stopPolling = () => {
    clearInterval(poll);
    poll = null;
  };
  const tick = async () => {
    const busy = await refreshField(tab);
    if (!busy) stopPolling();
  };
  const startPolling = () => {
    if (poll === null) poll = setInterval(tick, 1000);
  };
  startPolling();
  addEventListener("pagehide", stopPolling);
  // A check can start while the popup is open - the Check button below does exactly that.
  $("check").addEventListener("click", startPolling);
}

init();
