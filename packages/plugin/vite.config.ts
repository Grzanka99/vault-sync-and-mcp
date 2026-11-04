import { defineConfig } from "vite-plus";

// Obsidian loads one CommonJS file (main.js) next to manifest.json; it provides `obsidian` itself.
// manifest.json lives at the repo root: the Obsidian community directory reads it from there.
export default defineConfig({
  pack: {
    entry: { main: "src/main.ts" },
    format: ["cjs"],
    platform: "browser",
    target: "es2022",
    outDir: "dist",
    outExtensions: () => ({ js: ".js" }),
    hash: false,
    dts: false,
    clean: true,
    deps: {
      neverBundle: ["obsidian", "electron"],
      alwaysBundle: ["@mcp-vault/core"],
    },
    copy: ["../../manifest.json"],
  },
});
