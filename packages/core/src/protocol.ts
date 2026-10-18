// Wire protocol shared by the server and every sync client.

export const API_VERSION = 1;

/** Server-side record of a file. `seq` is a vault-wide monotonic counter bumped on every change. */
export interface FileEntry {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  seq: number;
  deleted: boolean;
  /** Name of the device/agent that made the last change. */
  device?: string;
}

export interface StatusResponse {
  name: "mcp-vault";
  apiVersion: number;
  vaultId: string;
}

export interface ChangesResponse {
  vaultId: string;
  entries: FileEntry[];
  /** Pass back as `since` on the next call. */
  cursor: number;
  more: boolean;
}

/**
 * ok        – stored as sent
 * unchanged – server already had identical content
 * merged    – server 3-way merged with its newer version; client must download
 * conflict  – could not merge; server kept its version and stored the upload as `conflictPath`
 */
export type PutStatus = "ok" | "unchanged" | "merged" | "conflict";

export interface PutResponse {
  status: PutStatus;
  entry: FileEntry;
  conflictPath?: string;
}

/** modified – server copy changed since `base`, delete refused (modification wins). */
export interface DeleteResponse {
  status: "ok" | "gone" | "modified";
  entry?: FileEntry;
}

export interface LoginRequest {
  username: string;
  password: string;
  deviceName: string;
}

export interface LoginResponse {
  token: string;
  tokenId: number;
  username: string;
  deviceName: string;
}

export interface MeResponse {
  username: string;
  tokenId: number;
  deviceName: string;
}

export type ServerEvent =
  | { type: "hello"; seq: number; vaultId: string }
  /** `origin` is the token id that caused the change(s), when they all came from one token. */
  | { type: "changed"; seq: number; origin?: string };
