import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ApiError, VaultClient } from "@mcp-vault/core";
import { fetchHttp, startServer, tick, type TestServer } from "./helpers.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  await server.close();
});

describe("sync between two devices", () => {
  it("copies new, edited and deleted files", async () => {
    const laptop = await server.newClient("laptop");
    const phone = await server.newClient("phone");

    await laptop.write("Notes/Plan.md", "# Plan\n");
    await laptop.write("image.png", "\0binary");
    await laptop.engine.sync();
    await phone.engine.sync();
    expect(await phone.read("Notes/Plan.md")).toBe("# Plan\n");
    expect(await phone.read("image.png")).toBe("\0binary");

    await phone.write("Notes/Plan.md", "# Plan\n- step 1\n");
    await phone.engine.sync();
    await laptop.engine.sync();
    expect(await laptop.read("Notes/Plan.md")).toBe("# Plan\n- step 1\n");

    await laptop.remove("image.png");
    await laptop.engine.sync();
    await phone.engine.sync();
    expect(await phone.read("image.png")).toBeNull();
  });

  it("merges edits to different lines", async () => {
    const laptop = await server.newClient("laptop");
    const phone = await server.newClient("phone");
    await laptop.write("todo.md", "one\ntwo\nthree\n");
    await laptop.engine.sync();
    await phone.engine.sync();

    await laptop.write("todo.md", "ONE\ntwo\nthree\n");
    await phone.write("todo.md", "one\ntwo\nTHREE\n");
    await laptop.engine.sync();
    const report = await phone.engine.sync();
    await laptop.engine.sync();

    expect(report.merged).toEqual(["todo.md"]);
    expect(await phone.read("todo.md")).toBe("ONE\ntwo\nTHREE\n");
    expect(await laptop.read("todo.md")).toBe("ONE\ntwo\nTHREE\n");
  });

  it("keeps both versions when edits overlap", async () => {
    const laptop = await server.newClient("laptop");
    const phone = await server.newClient("phone");
    await laptop.write("idea.md", "draft\n");
    await laptop.engine.sync();
    await phone.engine.sync();

    await laptop.write("idea.md", "laptop version\n");
    await phone.write("idea.md", "phone version\n");
    await laptop.engine.sync();
    const report = await phone.engine.sync();
    await laptop.engine.sync();

    expect(report.conflicts.length).toBe(1);
    const copy = report.conflicts[0];
    expect(copy.startsWith("idea (conflict phone ")).toBe(true);
    expect(await phone.read("idea.md")).toBe("laptop version\n");
    expect(await phone.read(copy)).toBe("phone version\n");
    expect(await laptop.read(copy)).toBe("phone version\n");
  });

  it("lets an edit win over a delete", async () => {
    const laptop = await server.newClient("laptop");
    const phone = await server.newClient("phone");
    await laptop.write("keep.md", "v1\n");
    await laptop.engine.sync();
    await phone.engine.sync();

    await phone.write("keep.md", "v2\n");
    await phone.engine.sync();
    await laptop.remove("keep.md");
    await laptop.engine.sync();

    expect(await laptop.read("keep.md")).toBe("v2\n");
  });

  it("does nothing when nothing changed", async () => {
    const laptop = await server.newClient("laptop");
    await laptop.write("a.md", "a\n");
    await laptop.engine.sync();
    const report = await laptop.engine.sync();
    expect(report).toEqual({
      uploaded: [],
      downloaded: [],
      deleted: [],
      merged: [],
      conflicts: [],
      errors: [],
    });
  });

  it("skips hidden files and the Obsidian workspace layout", async () => {
    const laptop = await server.newClient("laptop");
    await laptop.write(".obsidian/workspace.json", "{}");
    await laptop.write(".hidden/secret.md", "x");
    await laptop.write("visible.md", "y");
    const report = await laptop.engine.sync();
    expect(report.uploaded).toEqual(["visible.md"]);
  });
});

describe("server side changes", () => {
  it("picks up files an agent edits directly on disk", async () => {
    const laptop = await server.newClient("laptop");
    await fsp.mkdir(nodePath.join(server.vaultDir, "Agent"), { recursive: true });
    await fsp.writeFile(nodePath.join(server.vaultDir, "Agent", "report.md"), "written by agent\n");
    await new Promise((resolve) => setTimeout(resolve, 500));

    await laptop.engine.sync();
    expect(await laptop.read("Agent/report.md")).toBe("written by agent\n");
  });

  it("delivers MCP writes to clients", async () => {
    const laptop = await server.newClient("laptop");
    await server.vault.writeNote("from-mcp.md", new TextEncoder().encode("hi\n"), null, {
      id: "t",
      name: "agent",
    });
    await laptop.engine.sync();
    expect(await laptop.read("from-mcp.md")).toBe("hi\n");
  });

  it("rejects an MCP write based on a stale version", async () => {
    const actor = { id: "t", name: "agent" };
    const first = await server.vault.writeNote("n.md", new TextEncoder().encode("1"), null, actor);
    await tick();
    await server.vault.writeNote("n.md", new TextEncoder().encode("2"), first.hash, actor);
    await expect(
      server.vault.writeNote("n.md", new TextEncoder().encode("3"), first.hash, actor),
    ).rejects.toThrow("changed since you read it");
  });
});

describe("auth", () => {
  it("refuses a wrong password and unauthenticated requests", async () => {
    const client = new VaultClient({ baseUrl: server.url, http: fetchHttp });
    await expect(client.login("alice", "nope", "x")).rejects.toBeInstanceOf(ApiError);
    await expect(client.changes(0)).rejects.toMatchObject({ status: 401 });
  });

  it("stops working after logout", async () => {
    const laptop = await server.newClient("laptop");
    const token = laptop.client.token;
    await laptop.client.logout();
    const stale = new VaultClient({ baseUrl: server.url, token, http: fetchHttp });
    await expect(stale.changes(0)).rejects.toMatchObject({ status: 401 });
  });
});
