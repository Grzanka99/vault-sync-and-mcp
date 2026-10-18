// Helpers for pre-commit checks: they look at what is staged, not the working tree.

import { execFileSync } from "node:child_process";

function git(args: string[]): Buffer {
  return execFileSync("git", args, { maxBuffer: 256 * 1024 * 1024 });
}

/** Added, copied, modified or renamed files in the index (deletions don't matter). */
export function stagedFiles(): string[] {
  const output = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).toString("utf8");
  return output.split("\0").filter((path) => path !== "");
}

/** The staged content of a file – what will actually be committed. */
export function readStaged(path: string): Buffer {
  return git(["show", `:${path}`]);
}

/** Binary files (images, fonts, …) contain NUL bytes; text files don't. */
export function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}
