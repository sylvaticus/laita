// Keeps development files out of the signed package (and out of `web-ext lint`).
//
// web-ext looks for this file in the *current directory*, not in --source-dir, so every
// web-ext command has to be run from inside browser/. Running it from the repository
// root silently ignores ignoreFiles and lints test/ as if it were shipped.
//
// Docs, screenshots and the roadmap live above this directory and are excluded simply by
// not being in the source directory.
module.exports = {
  ignoreFiles: [
    "test",
    "tools",
    "dist-chrome",
    "manifest.chrome.json",
    "web-ext-artifacts",
    "web-ext-config.cjs",
    "node_modules",
    "package*.json"
  ],
  // Default would be "laita_-_local_ai_text_assistant-<version>.zip". Named for the
  // browser, because the Chrome package sits in the same directory and uploading one to
  // the wrong store fails.
  build: { filename: "laita-firefox-{version}.zip" }
};
