import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "packages/cli/dist/**",
      "packages/**/dist/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
        Bun: "readonly",
      },
    },
  },
);
