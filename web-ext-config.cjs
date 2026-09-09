// Keeps development files out of the signed package (and out of `web-ext lint`).
module.exports = {
  ignoreFiles: [
    "test",
    "web-ext-artifacts",
    "web-ext-config.cjs",
    "CLAUDE.md",
    "README.md",
    "node_modules",
    "package*.json"
  ]
};
