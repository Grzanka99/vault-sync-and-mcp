// WebCrypto exists in Node, Electron and the mobile webviews, so one implementation serves all.

export async function sha256Hex(data: Uint8Array): Promise<string> {
  // WebCrypto's types want an ArrayBuffer-backed view; ours always are, and copying big files would be wasteful.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  let out = "";
  for (const byte of new Uint8Array(digest)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const encodeText = (s: string): Uint8Array => encoder.encode(s);
export const decodeText = (b: Uint8Array): string => decoder.decode(b);
