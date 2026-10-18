// HTTP through Obsidian's requestUrl: no CORS limits, and it works the same on desktop and mobile.

import { requestUrl } from "obsidian";
import type { HttpFn } from "@mcp-vault/core";

/** Obsidian wants an ArrayBuffer that holds exactly these bytes. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const isWholeBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  if (isWholeBuffer && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export const obsidianHttp: HttpFn = async (request) => {
  let body: string | ArrayBuffer | undefined = undefined;
  if (typeof request.body === "string") {
    body = request.body;
  } else if (request.body) {
    body = toArrayBuffer(request.body);
  }

  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    contentType: request.headers?.["content-type"],
    body,
    throw: false,
  });

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    headers[name.toLowerCase()] = value;
  }
  return { status: response.status, headers, body: new Uint8Array(response.arrayBuffer) };
};
