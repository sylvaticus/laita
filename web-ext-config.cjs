// Keeps development files out of the signed package (and out of `web-ext lint`).
module.exports = {
  ignoreFiles: [
    "test",
    "doc",
    "assets",
    "web-ext-artifacts",
    "web-ext-config.cjs",
    "CLAUDE.md",
    "README.md",
    "secrets",
    "node_modules",
    "package*.json"
  ]
};
