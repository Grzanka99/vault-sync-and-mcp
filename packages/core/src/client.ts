import type {
  ChangesResponse,
  DeleteResponse,
  FileEntry,
  LoginResponse,
  MeResponse,
  PutResponse,
  StatusResponse,
} from "./protocol.ts";

// The transport is injected: Obsidian's requestUrl (no CORS, works on mobile) or fetch in Node.
export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export interface HttpResponse {
  status: number;
  /** Header names are lower-case. */
  headers: Record<string, string>;
  body: Uint8Array;
}

export type HttpFn = (request: HttpRequest) => Promise<HttpResponse>;

/** The server answered with an error status. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** The server could not be reached. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/** What the sync engine needs from the server. */
export interface RemoteApi {
  changes(since: number): Promise<ChangesResponse>;
  download(path: string): Promise<{ data: Uint8Array; entry: FileEntry }>;
  upload(path: string, data: Uint8Array, baseHash: string | null): Promise<PutResponse>;
  remove(path: string, baseHash: string | null): Promise<DeleteResponse>;
}

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end--;
  }
  return url.slice(0, end);
}

export class VaultClient implements RemoteApi {
  readonly baseUrl: string;
  token: string | null;
  private http: HttpFn;

  constructor(options: { baseUrl: string; token?: string | null; http: HttpFn }) {
    this.baseUrl = stripTrailingSlashes(options.baseUrl);
    this.token = options.token ?? null;
    this.http = options.http;
  }

  /**
   * ws(s):// URL for live change notifications. Browsers can't set headers on a WebSocket,
   * so the token travels in the query string.
   */
  liveUrl(): string {
    let wsBase = this.baseUrl;
    if (wsBase.startsWith("https://")) {
      wsBase = "wss://" + wsBase.slice("https://".length);
    } else if (wsBase.startsWith("http://")) {
      wsBase = "ws://" + wsBase.slice("http://".length);
    }
    return `${wsBase}/api/ws?token=${encodeURIComponent(this.token ?? "")}`;
  }

  async status(): Promise<StatusResponse> {
    return this.requestJson("GET", "/api/status");
  }

  async login(username: string, password: string, deviceName: string): Promise<LoginResponse> {
    const response = await this.requestJson<LoginResponse>("POST", "/api/login", {
      username,
      password,
      deviceName,
    });
    this.token = response.token;
    return response;
  }

  async logout(): Promise<void> {
    await this.requestJson("POST", "/api/logout", {});
    this.token = null;
  }

  async me(): Promise<MeResponse> {
    return this.requestJson("GET", "/api/me");
  }

  async changes(since: number): Promise<ChangesResponse> {
    return this.requestJson("GET", `/api/changes?since=${since}`);
  }

  async download(path: string): Promise<{ data: Uint8Array; entry: FileEntry }> {
    const response = await this.send({ method: "GET", url: `/api/file?path=${encodeURIComponent(path)}` });
    const headers = response.headers;
    const entry: FileEntry = {
      path,
      hash: headers["x-hash"] ?? "",
      size: Number(headers["x-size"] ?? response.body.byteLength),
      mtime: Number(headers["x-mtime"] ?? 0),
      seq: Number(headers["x-seq"] ?? 0),
      deleted: false,
    };
    return { data: response.body, entry };
  }

  async upload(path: string, data: Uint8Array, baseHash: string | null): Promise<PutResponse> {
    const response = await this.send({
      method: "PUT",
      url: `/api/file?path=${encodeURIComponent(path)}`,
      headers: { "content-type": "application/octet-stream", "x-base-hash": baseHash ?? "" },
      body: data,
    });
    return parseJson(response);
  }

  async remove(path: string, baseHash: string | null): Promise<DeleteResponse> {
    const query = `path=${encodeURIComponent(path)}&base=${encodeURIComponent(baseHash ?? "")}`;
    const response = await this.send({ method: "DELETE", url: `/api/file?${query}` });
    return parseJson(response);
  }

  private async requestJson<T>(method: string, url: string, body?: unknown): Promise<T> {
    const request: HttpRequest = { method, url, headers: {} };
    if (body !== undefined) {
      request.headers = { "content-type": "application/json" };
      request.body = JSON.stringify(body);
    }
    return parseJson(await this.send(request));
  }

  private async send(request: HttpRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...request.headers };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }

    let response: HttpResponse;
    try {
      response = await this.http({ ...request, url: this.baseUrl + request.url, headers });
    } catch (error) {
      throw new NetworkError(errorMessage(error));
    }

    if (response.status >= 400) {
      throw new ApiError(response.status, readErrorMessage(response));
    }
    return response;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readErrorMessage(response: HttpResponse): string {
  try {
    const parsed = parseJson<{ error?: string }>(response);
    if (parsed.error) {
      return parsed.error;
    }
  } catch {
    // Not JSON – fall through to the generic message.
  }
  return `HTTP ${response.status}`;
}

/** Trust boundary: the server's JSON is taken to match the protocol types. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
function parseJson<T>(response: HttpResponse): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(new TextDecoder().decode(response.body)) as T;
}
