import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { FileEntry } from "@mcp-vault/core";

const SCHEMA = `
create table if not exists meta(key text primary key, value text not null);
create table if not exists files(
  path text primary key,
  hash text not null,
  size integer not null,
  mtime integer not null,
  seq integer not null,
  deleted integer not null default 0,
  device text
);
create index if not exists files_seq on files(seq);
-- Contents of mergeable text versions, so the server can 3-way merge against any recent base.
create table if not exists blobs(hash text primary key, data blob not null, created integer not null);
create table if not exists history(
  id integer primary key,
  path text not null,
  hash text,
  seq integer not null,
  ts integer not null,
  device text
);
create index if not exists history_path on history(path, id);
create table if not exists users(
  id integer primary key,
  username text not null unique,
  pw_hash text not null,
  created integer not null
);
create table if not exists tokens(
  id integer primary key,
  user_id integer not null references users(id) on delete cascade,
  name text not null,
  kind text not null,
  token_hash text not null unique,
  created integer not null,
  last_used integer
);
create virtual table if not exists notes_fts using fts5(path unindexed, title, body, tokenize = 'porter unicode61');
`;

export interface TokenInfo {
  id: number;
  userId: number;
  username: string;
  name: string;
  kind: "device" | "api";
  created: number;
  lastUsed: number | null;
}

export interface SearchHit {
  path: string;
  snippet: string;
}

type Row = Record<string, unknown>;

// Typed column readers: SQLite hands back `unknown`, these check instead of casting.
function columnText(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`column ${column} is not text`);
  }
  return value;
}

function columnTextOrNull(row: Row, column: string): string | null {
  if (row[column] === null || row[column] === undefined) {
    return null;
  }
  return columnText(row, column);
}

function tokenKind(value: string): TokenInfo["kind"] {
  if (value === "api") {
    return "api";
  }
  return "device";
}

function splitWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const ch of text) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (current !== "") {
        words.push(current);
      }
      current = "";
    } else {
      current += ch;
    }
  }
  if (current !== "") {
    words.push(current);
  }
  return words;
}

/**
 * Turn free text into an FTS5 query: every word is quoted so user input can't trigger
 * FTS5 syntax errors, and a trailing "*" keeps prefix search ("proj*" finds "project").
 */
function toFtsQuery(text: string): string {
  const terms: string[] = [];
  for (const word of splitWords(text)) {
    let bare = word;
    while (bare.endsWith("*")) {
      bare = bare.slice(0, -1);
    }
    if (bare === "") {
      continue;
    }
    let term = `"${bare.replaceAll('"', '""')}"`;
    if (word.endsWith("*")) {
      term += "*";
    }
    terms.push(term);
  }
  return terms.join(" ");
}

const toEntry = (r: Row): FileEntry => ({
  path: columnText(r, "path"),
  hash: columnText(r, "hash"),
  size: Number(r.size),
  mtime: Number(r.mtime),
  seq: Number(r.seq),
  deleted: Number(r.deleted) === 1,
  device: columnTextOrNull(r, "device") ?? undefined,
});

const toToken = (r: Row): TokenInfo => ({
  id: Number(r.id),
  userId: Number(r.user_id),
  username: columnText(r, "username"),
  name: columnText(r, "name"),
  kind: tokenKind(columnText(r, "kind")),
  created: Number(r.created),
  lastUsed: optionalNumber(r.last_used),
});

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

export class Store {
  readonly db: DatabaseSync;
  readonly readOnly: boolean;
  private seq = 0;

  constructor(file: string, opts: { readOnly?: boolean } = {}) {
    this.readOnly = !!opts.readOnly;
    this.db = new DatabaseSync(file, { readOnly: this.readOnly });
    if (!this.readOnly) {
      this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
      this.db.exec(SCHEMA);
      if (!this.getMeta("vault_id")) {
        this.setMeta("vault_id", randomUUID());
      }
    }
    this.seq = Number(this.one("select coalesce(max(seq), 0) as s from files")?.s ?? 0);
  }

  close(): void {
    this.db.close();
  }

  get vaultId(): string {
    return this.getMeta("vault_id") ?? "";
  }

  get currentSeq(): number {
    return this.seq;
  }

  nextSeq(): number {
    return ++this.seq;
  }

  tx<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  // ── meta ──
  getMeta(key: string): string | null {
    const row = this.one("select value from meta where key = ?", key);
    if (!row) {
      return null;
    }
    return columnText(row, "value");
  }

  setMeta(key: string, value: string): void {
    this.run(
      "insert into meta(key, value) values(?, ?) on conflict(key) do update set value = excluded.value",
      key,
      value,
    );
  }

  // ── files ──
  getFile(path: string): FileEntry | null {
    const row = this.one("select * from files where path = ?", path);
    if (!row) {
      return null;
    }
    return toEntry(row);
  }

  liveFile(path: string): FileEntry | null {
    const file = this.getFile(path);
    if (!file || file.deleted) {
      return null;
    }
    return file;
  }

  /** Live files, optionally only those under `prefix/`. */
  liveFiles(prefix?: string): FileEntry[] {
    if (!prefix) {
      return this.all("select * from files where deleted = 0").map(toEntry);
    }
    const folder = `${prefix}/`;
    return this.all(
      "select * from files where deleted = 0 and substr(path, 1, ?) = ?",
      folder.length,
      folder,
    ).map(toEntry);
  }

  upsertFile(e: FileEntry): void {
    this.run(
      `insert into files(path, hash, size, mtime, seq, deleted, device) values(?, ?, ?, ?, ?, ?, ?)
       on conflict(path) do update set hash = excluded.hash, size = excluded.size, mtime = excluded.mtime,
         seq = excluded.seq, deleted = excluded.deleted, device = excluded.device`,
      e.path,
      e.hash,
      e.size,
      e.mtime,
      e.seq,
      Number(e.deleted),
      e.device ?? null,
    );
  }

  /** Record a new mtime for identical content without producing a change. */
  touch(path: string, mtime: number): void {
    this.run("update files set mtime = ? where path = ?", mtime, path);
  }

  changes(since: number, limit: number): FileEntry[] {
    return this.all("select * from files where seq > ? order by seq limit ?", since, limit).map(toEntry);
  }

  recent(limit: number): FileEntry[] {
    return this.all("select * from files order by seq desc limit ?", limit).map(toEntry);
  }

  // ── blobs / history ──
  putBlob(hash: string, data: Uint8Array): void {
    this.run("insert or ignore into blobs(hash, data, created) values(?, ?, ?)", hash, data, Date.now());
  }

  getBlob(hash: string): Uint8Array | null {
    const row = this.one("select data from blobs where hash = ?", hash);
    if (!row || !(row.data instanceof Uint8Array)) {
      return null;
    }
    return row.data;
  }

  addHistory(path: string, hash: string | null, seq: number, device: string): void {
    this.run(
      "insert into history(path, hash, seq, ts, device) values(?, ?, ?, ?, ?)",
      path,
      hash,
      seq,
      Date.now(),
      device,
    );
  }

  history(
    path: string,
    limit = 50,
  ): { hash: string | null; seq: number; ts: number; device: string | null }[] {
    return this.all(
      "select hash, seq, ts, device from history where path = ? order by id desc limit ?",
      path,
      limit,
    ).map((r) => ({
      hash: columnTextOrNull(r, "hash"),
      seq: Number(r.seq),
      ts: Number(r.ts),
      device: columnTextOrNull(r, "device"),
    }));
  }

  /** Drop history older than `cutoff` (keeping each path's latest row) and blobs nothing refers to. */
  gc(cutoff: number): void {
    this.tx(() => {
      this.run(
        "delete from history where ts < ? and id not in (select max(id) from history group by path)",
        cutoff,
      );
      this.run(
        `delete from blobs where hash not in (select hash from history where hash is not null)
           and hash not in (select hash from files where deleted = 0)`,
      );
    });
  }

  // ── full-text search ──
  ftsUpsert(path: string, title: string, body: string): void {
    this.run("delete from notes_fts where path = ?", path);
    this.run("insert into notes_fts(path, title, body) values(?, ?, ?)", path, title, body);
  }

  ftsDelete(path: string): void {
    this.run("delete from notes_fts where path = ?", path);
  }

  search(query: string, limit: number): SearchHit[] {
    const match = toFtsQuery(query);
    if (match === "") {
      return [];
    }
    return this.all(
      `select path, snippet(notes_fts, 2, '**', '**', '…', 16) as snippet from notes_fts
       where notes_fts match ? order by bm25(notes_fts, 0, 5, 1) limit ?`,
      match,
      limit,
    ).map((r) => ({ path: columnText(r, "path"), snippet: columnText(r, "snippet") }));
  }

  // ── users / tokens ──
  createUser(username: string, pwHash: string): number {
    return Number(
      this.run("insert into users(username, pw_hash, created) values(?, ?, ?)", username, pwHash, Date.now())
        .lastInsertRowid,
    );
  }

  getUser(username: string): { id: number; username: string; pwHash: string } | null {
    const row = this.one("select id, username, pw_hash from users where username = ?", username);
    if (!row) {
      return null;
    }
    return { id: Number(row.id), username: columnText(row, "username"), pwHash: columnText(row, "pw_hash") };
  }

  listUsers(): { id: number; username: string; created: number }[] {
    return this.all("select id, username, created from users order by id").map((r) => ({
      id: Number(r.id),
      username: columnText(r, "username"),
      created: Number(r.created),
    }));
  }

  userCount(): number {
    return Number(this.one("select count(*) as n from users")?.n ?? 0);
  }

  setPassword(userId: number, pwHash: string): void {
    this.run("update users set pw_hash = ? where id = ?", pwHash, userId);
  }

  deleteUser(userId: number): void {
    this.run("delete from users where id = ?", userId);
  }

  createToken(userId: number, name: string, kind: TokenInfo["kind"], tokenHash: string): number {
    return Number(
      this.run(
        "insert into tokens(user_id, name, kind, token_hash, created) values(?, ?, ?, ?, ?)",
        userId,
        name,
        kind,
        tokenHash,
        Date.now(),
      ).lastInsertRowid,
    );
  }

  findToken(tokenHash: string): TokenInfo | null {
    const row = this.one(
      "select t.*, u.username from tokens t join users u on u.id = t.user_id where t.token_hash = ?",
      tokenHash,
    );
    if (!row) {
      return null;
    }
    return toToken(row);
  }

  touchToken(id: number): void {
    this.run("update tokens set last_used = ? where id = ?", Date.now(), id);
  }

  listTokens(): TokenInfo[] {
    return this.all(
      "select t.*, u.username from tokens t join users u on u.id = t.user_id order by t.id",
    ).map(toToken);
  }

  deleteToken(id: number): boolean {
    return Number(this.run("delete from tokens where id = ?", id).changes) > 0;
  }

  // ── helpers ──
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params);
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params);
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
}
