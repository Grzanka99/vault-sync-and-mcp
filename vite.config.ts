import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 110,
    ignorePatterns: ["**/dist/**", "pnpm-lock.yaml"],
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/node_modules/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    categories: {
      correctness: "error",
      suspicious: "warn",
    },
    rules: {
      // House style: readable code, no shortcuts (see AGENTS.md).
      curly: ["error", "all"],
      "no-ternary": "error",
      "no-nested-ternary": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  staged: {
    "*.{ts,js,json,md,yaml}": "vp check --fix",
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
