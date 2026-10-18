// Test harness: a real server on a random port plus sync clients that use plain folders.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
  SyncEngine,
  VaultClient,
  createClientFilter,
  emptyState,
  type HttpFn,
  type LocalFile,
  type LocalFs,
  type LocalStat,
  type SyncFilter,
} from "@mcp-vault/core";
import { hashPassword } from "../src/auth.ts";
import { createHttpServer } from "../src/http.ts";
import { Store } from "../src/store.ts";
import { Vault } from "../src/vault.ts";

export const fetchHttp: HttpFn = async (request) => {
  let body: BodyInit | undefined = undefined;
  if (typeof request.body === "string") {
    body = request.body;
  } else if (request.body) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    body = new Blob([request.body as Uint8Array<ArrayBuffer>]);
  }
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
};

/** LocalFs on a normal folder – what the Obsidian adapter does, minus Obsidian. */
export class FolderFs implements LocalFs {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private absolute(path: string): string {
    return nodePath.join(this.root, ...path.split("/"));
  }

  async list(filter: SyncFilter): Promise<LocalFile[]> {
    const out: LocalFile[] = [];
    const visit = async (folder: string) => {
      const entries = await fsp.readdir(this.absolute(folder), { withFileTypes: true });
      for (const entry of entries) {
        let path = entry.name;
        if (folder !== "") {
          path = `${folder}/${entry.name}`;
        }
        if (entry.isDirectory()) {
          if (filter.allowsFolder(path)) {
            await visit(path);
          }
        } else if (entry.isFile()) {
          const stat = await fsp.stat(this.absolute(path));
          out.push({ path, mtime: Math.floor(stat.mtimeMs), size: stat.size });
        }
      }
    };
    await visit("");
    return out;
  }

  async stat(path: string): Promise<LocalStat | null> {
    try {
      const stat = await fsp.stat(this.absolute(path));
      return { mtime: Math.floor(stat.mtimeMs), size: stat.size };
    } catch {
      return null;
    }
  }

  async read(path: string): Promise<Uint8Array> {
    return fsp.readFile(this.absolute(path));
  }

  async write(path: string, data: Uint8Array): Promise<LocalStat> {
    await fsp.mkdir(nodePath.dirname(this.absolute(path)), { recursive: true });
    await fsp.writeFile(this.absolute(path), data);
    const stat = await this.stat(path);
    if (!stat) {
      throw new Error(`write failed: ${path}`);
    }
    return stat;
  }

  async remove(path: string): Promise<void> {
    await fsp.rm(this.absolute(path), { force: true });
  }
}

export interface TestClient {
  folder: string;
  engine: SyncEngine;
  client: VaultClient;
  write(path: string, text: string): Promise<void>;
  read(path: string): Promise<string | null>;
  remove(path: string): Promise<void>;
}

export interface TestServer {
  url: string;
  vaultDir: string;
  vault: Vault;
  newClient(deviceName: string): Promise<TestClient>;
  close(): Promise<void>;
}

/** mtime has millisecond resolution; make sure a rewrite is visible as a change. */
export async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

export async function startServer(): Promise<TestServer> {
  const base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "mcp-vault-test-"));
  const vaultDir = nodePath.join(base, "server-vault");
  const store = new Store(nodePath.join(base, "index.db"));
  store.createUser("alice", await hashPassword("password123"));
  const vault = new Vault({ root: vaultDir, store });
  await vault.start();
  const server = createHttpServer({
    vault,
    store,
    maxUploadBytes: 10 * 1024 * 1024,
    trustProxy: false,
    localToken: null,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server has no port");
  }
  const url = `http://127.0.0.1:${address.port}`;

  async function newClient(deviceName: string): Promise<TestClient> {
    const folder = nodePath.join(base, deviceName);
    await fsp.mkdir(folder, { recursive: true });
    const client = new VaultClient({ baseUrl: url, http: fetchHttp });
    await client.login("alice", "password123", deviceName);
    const fs = new FolderFs(folder);
    const filter = createClientFilter({ configDir: ".obsidian", syncConfig: false });
    const engine = new SyncEngine({
      fs,
      remote: client,
      filter,
      state: emptyState(),
      saveState: async () => {},
    });
    return {
      folder,
      engine,
      client,
      write: async (path, text) => {
        await tick();
        await fs.write(path, new TextEncoder().encode(text));
      },
      read: async (path) => {
        if (!(await fs.stat(path))) {
          return null;
        }
        return new TextDecoder().decode(await fs.read(path));
      },
      remove: (path) => fs.remove(path),
    };
  }

  return {
    url,
    vaultDir,
    vault,
    newClient,
    close: async () => {
      vault.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      await fsp.rm(base, { recursive: true, force: true });
    },
  };
}
