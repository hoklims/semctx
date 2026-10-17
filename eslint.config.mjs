import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "**/.venv/**",
      ".semctx/**",
      "benchmarks/change-impact-eval/.semctx-bench/**",
      "benchmarks/change-impact-eval/data/**",
      "benchmarks/change-impact-eval/output/**",
      "examples/**",
      "graphify-out/**",
      "packages/python-analyzer/test/corpus/**",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `tsc` already owns unused symbols. These two rules otherwise turn the
      // initial quality gate into a mechanical cleanup rather than a bug gate.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
      // Async callbacks are part of several host interfaces even when one
      // implementation completes synchronously.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/test/**/*.ts"],
    rules: {
      // Tests deliberately inspect untrusted JSON and forged protocol payloads.
      // Production sources retain the full type-aware unsafe-value rules.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    files: ["**/*.{cjs,js,mjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
);
