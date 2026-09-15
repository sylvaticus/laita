/**
 * Lint rules, in three flavours because this repository holds three kinds of JavaScript.
 *
 * The rule that earns its keep is no-unsanitized. CLAUDE.md states that model output must
 * never become markup, and today the content scripts honour that by hand - every node is
 * built with createElement and textContent. A discipline that lives only in prose lasts
 * until the first contributor in a hurry; this makes it mechanical.
 */
import globals from "globals";
import noUnsanitized from "eslint-plugin-no-unsanitized";

const shared = {
  "no-unsanitized/method": "error",
  "no-unsanitized/property": "error",
  "no-var": "error",
  "prefer-const": "error",
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-implicit-coercion": "off",
  "no-unused-vars": ["error", {
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrors: "none"
  }],
  "no-console": "off"
};

export default [
  {
    ignores: [
      "node_modules/**",
      // A generated copy of browser/src; linting it reports every problem twice.
      "browser/dist-chrome/**",
      // A copied copy of browser/src/background, for the same reason.
      "vscode/core/**",
      "browser/web-ext-artifacts/**",
      "**/*.vsix"
    ]
  },
  {
    // Background and page scripts: ES modules with the extension APIs.
    files: ["browser/src/background/**/*.js", "browser/src/common/**/*.js",
            "browser/src/options/**/*.js", "browser/src/popup/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.webextensions }
    },
    plugins: { "no-unsanitized": noUnsanitized },
    rules: shared
  },
  {
    // Content scripts are classic scripts - they cannot import, and they share one global
    // LAITA object across files, so sourceType is "script" and LAITA is writable.
    files: ["browser/src/content/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions, LAITA: "writable" }
    },
    plugins: { "no-unsanitized": noUnsanitized },
    rules: shared
  },
  {
    // The VS Code extension host loads CommonJS.
    files: ["vscode/src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node }
    },
    plugins: { "no-unsanitized": noUnsanitized },
    rules: shared
  },
  {
    files: ["browser/test/**/*.mjs", "vscode/test/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser, LAITA: "writable" }
    },
    plugins: { "no-unsanitized": noUnsanitized },
    // Tests build hostile markup on purpose to prove the real code refuses it.
    rules: { ...shared, "no-unsanitized/property": "off", "no-unsanitized/method": "off" }
  }
];
