import { merge } from "node-diff3";

const strict = new TextDecoder("utf-8", { fatal: true });

function utf8(bytes: Uint8Array): string | null {
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Line-based 3-way merge. Returns the merged text, or null when edits overlap
 * (or any side isn't valid UTF-8) and the caller must fall back to a conflict copy.
 */
export function merge3(ours: Uint8Array, base: Uint8Array, theirs: Uint8Array): string | null {
  const oursText = utf8(ours);
  const baseText = utf8(base);
  const theirsText = utf8(theirs);
  if (oursText === null || baseText === null || theirsText === null) {
    return null;
  }
  const result = merge(oursText.split("\n"), baseText.split("\n"), theirsText.split("\n"));
  if (result.conflict) {
    return null;
  }
  return result.result.join("\n");
}
