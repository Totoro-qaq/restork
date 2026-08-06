import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // A line that cannot be read in a diff cannot be reviewed. This is a
      // ceiling, not a style preference: `render.ts` reached 1,756 characters.
      "max-len": ["error", { code: 200, ignoreUrls: true, ignoreRegExpLiterals: true }],
    },
  },
  {
    // Known debt. `render.ts` inlines both locales at every call site, which is
    // the root cause of its line lengths; Stage 5 replaces that with a catalog.
    // The ratchet in `tests/reviewability.test.ts` stops it from growing.
    files: ["src/ui/render.ts"],
    rules: { "max-len": "off" },
  },
  {
    ignores: ["dist/**"],
  },
);
