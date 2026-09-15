/**
 * dist-chrome/ is committed so Chrome users can "Load unpacked" straight from a
 * download, without Node, Python or a build step. The price of committing build output
 * is that it can silently go stale, so this fails the moment it stops matching src/.
 *
 * Fix a failure by running: cd browser && ./tools/build-chrome.sh
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIST = join(ROOT, "dist-chrome");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) pass++; else { fail++; console.log("FAIL " + name + (detail ? "\n  " + detail : "")); }
};

const walk = (dir) => readdirSync(dir).flatMap((e) => {
  const p = join(dir, e);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

ok("dist-chrome exists", existsSync(DIST), "run tools/build-chrome.sh");
if (existsSync(DIST)) {
  // every shipped source file must be byte-identical to the one in src/
  const stale = [];
  for (const f of walk(join(DIST, "src"))) {
    const rel = relative(DIST, f);
    const src = join(ROOT, rel);
    if (!existsSync(src)) { stale.push(rel + " (not in src/)"); continue; }
    if (!readFileSync(f).equals(readFileSync(src))) stale.push(rel + " (differs)");
  }
  ok("every src file matches", stale.length === 0, stale.join("\n  "));

  // and nothing in src/ is missing from the build
  const missing = walk(join(ROOT, "src"))
    .map((f) => relative(ROOT, f))
    .filter((rel) => !existsSync(join(DIST, rel)));
  ok("no src file left out", missing.length === 0, missing.join("\n  "));

  const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
  const chrome = JSON.parse(readFileSync(join(ROOT, "manifest.chrome.json"), "utf8"));
  ok("manifest is the Chrome one", JSON.stringify(manifest) === JSON.stringify(chrome));

  const firefox = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  ok("versions agree across manifests", manifest.version === firefox.version,
     `chrome ${manifest.version} vs firefox ${firefox.version}`);

  // <all_urls> in host_permissions let the background fetch any origin on the internet,
  // which is what turned a mis-set endpoint from a mistake into a form-field keylogger.
  // Content scripts are declared separately and keep their own <all_urls> matches; the
  // only thing the host permission bought was fetch-anywhere, and a remote endpoint now
  // asks for its origin through permissions.request instead.
  for (const [name, m] of [["chrome", manifest], ["firefox", firefox]]) {
    ok(`${name}: no <all_urls> host permission`,
       !(m.host_permissions || []).includes("<all_urls>"),
       JSON.stringify(m.host_permissions));
    ok(`${name}: loopback is still reachable without asking`,
       (m.host_permissions || []).includes("http://localhost/*") &&
       (m.host_permissions || []).includes("http://127.0.0.1/*"),
       JSON.stringify(m.host_permissions));
    ok(`${name}: a remote endpoint can still be granted on request`,
       (m.optional_host_permissions || []).length > 0,
       JSON.stringify(m.optional_host_permissions));
    ok(`${name}: content scripts still run everywhere`,
       m.content_scripts[0].matches.includes("<all_urls>"),
       JSON.stringify(m.content_scripts[0].matches));
  }

  // a manifest pointing at a file that is not there is the failure users would hit first
  const refs = [manifest.background.service_worker, manifest.options_ui.page,
                manifest.action.default_popup, ...manifest.content_scripts[0].js,
                ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  const dangling = [...new Set(refs)].filter((r) => !existsSync(join(DIST, r)));
  ok("every manifest reference resolves", dangling.length === 0, dangling.join(", "));
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
