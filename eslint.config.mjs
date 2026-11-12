import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "tools/rust-ts-r0/development-evidence/**",
      "tools/rust-ts-r0-ts7-experimental/development-evidence/**",
      "**/.venv/**",
      ".semctx/**",
      "benchmarks/change-impact-eval/.semctx-bench/**",
      "benchmarks/change-impact-eval/data/**",
      "benchmarks/change-impact-eval/output/**",
      "examples/**",
      "graphify-out/**",
      "packages/python-analyzer/test/corpus/**",
      "docs/research/rust-ts-r0/cases/supplement-v2/**",
      "docs/research/rust-ts-r0/cases/supplement-sdk-assignment-20261021/**",
      "docs/research/rust-ts-r0/cases/supplement-coercion-20261021/**",
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
  {
    files: ["tools/rust-ts-r0/qualification/*.cjs"],
    rules: {
      // Baseline oracles load the pinned CommonJS TypeScript runtime and
      // transpiled baseline modules. Keep the other JavaScript checks active.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
