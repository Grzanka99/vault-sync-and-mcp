import { describe, expect, it } from "vite-plus/test";
import {
  PathFilter,
  conflictPath,
  createClientFilter,
  isSafePath,
  matchGlob,
  normalizePath,
} from "../src/paths.ts";

describe("matchGlob", () => {
  it("handles *, ** and ?", () => {
    expect(matchGlob("*.md", "note.md")).toBe(true);
    expect(matchGlob("*.md", "a/note.md")).toBe(false);
    expect(matchGlob("**/*.md", "note.md")).toBe(true);
    expect(matchGlob("**/*.md", "a/b/note.md")).toBe(true);
    expect(matchGlob("a/**", "a/b/c")).toBe(true);
    expect(matchGlob("n?te.md", "note.md")).toBe(true);
    expect(matchGlob("n?te.md", "n/te.md")).toBe(false);
  });
});

describe("PathFilter", () => {
  const filter = new PathFilter(["node_modules/", "/Private/", "*.tmp", "/.obsidian/workspace.json"]);

  it("matches names at any depth, anchored paths only at the root", () => {
    expect(filter.excludes("x/node_modules/y.js")).toBe(true);
    expect(filter.excludes("Private/a.md")).toBe(true);
    expect(filter.excludes("Notes/Private/a.md")).toBe(false);
    expect(filter.excludes("a/b.tmp")).toBe(true);
    expect(filter.excludes(".obsidian/workspace.json")).toBe(true);
    expect(filter.excludes(".obsidian/app.json")).toBe(false);
  });

  it("applies folder-only rules to folders only", () => {
    expect(filter.excludes("node_modules")).toBe(false);
    expect(filter.excludes("node_modules", true)).toBe(true);
  });
});

describe("createClientFilter", () => {
  it("syncs the config folder only when enabled, never the plugin's own data", () => {
    const options = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/mcp-vault-sync" };
    const off = createClientFilter({ ...options, syncConfig: false });
    const on = createClientFilter({ ...options, syncConfig: true });
    expect(off.allows(".obsidian/app.json")).toBe(false);
    expect(on.allows(".obsidian/app.json")).toBe(true);
    expect(on.allows(".obsidian/plugins/mcp-vault-sync/data.json")).toBe(false);
    expect(on.allows(".obsidian/plugins/mcp-vault-sync/main.js")).toBe(true);
    expect(on.allows(".git/config")).toBe(false);
    expect(on.allows("Notes/.hidden.md")).toBe(false);
  });
});

describe("paths", () => {
  it("normalizes and validates", () => {
    expect(normalizePath("/a//b\\c/")).toBe("a/b/c");
    expect(isSafePath("a/../b")).toBe(false);
    expect(isSafePath("C:/x")).toBe(false);
    expect(isSafePath("a/b.md")).toBe(true);
  });

  it("names conflict copies", () => {
    const date = new Date("2026-10-18T15:30:12Z");
    expect(conflictPath("Notes/Plan.md", "My Phone", date)).toBe(
      "Notes/Plan (conflict My Phone 2026-10-18 15-30-12).md",
    );
    expect(conflictPath("README", "a/b", date)).toBe("README (conflict ab 2026-10-18 15-30-12)");
  });
});
