// @ts-check
import { defineConfig } from "eslint/config";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", "runs/", "coverage/", "node_modules/", "src/contracts/generated/"] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-restricted-syntax": [
        "error",
        { selector: "ExportDefaultDeclaration", message: "Use named exports (see CLAUDE.md)." },
      ],
    },
  },
  {
    files: ["eslint.config.js", "vitest.config.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // The Recorder page's browser script. It ships to Chromium as it is, so it is deliberately
    // outside the TypeScript project: there is no build step between this file and the page,
    // and `buildPage` inlines it verbatim. Linted for real mistakes, without type information.
    files: ["src/recorder/page/**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
      },
    },
  },
);
