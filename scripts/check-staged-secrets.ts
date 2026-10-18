// Pre-commit check: block staged files that look like they contain secrets.
// Run by .vite-hooks/pre-commit.

import { isBinary, readStaged, stagedFiles } from "./staged.ts";

/** Files that hold secrets by design and must never be committed. */
const FORBIDDEN_NAMES = [".env", "local-agent.token", "index.db", "index.db-wal", "index.db-shm"];
const FORBIDDEN_SUFFIXES = [".token", ".pem", ".key", ".p12"];
/** Templates that are meant to be committed. */
const ALLOWED_NAMES = [".env.example"];

interface TokenRule {
  name: string;
  prefix: string;
  /** How many token characters must follow the prefix to count as a real token. */
  minLength: number;
}

const TOKEN_RULES: TokenRule[] = [
  { name: "mcp-vault token", prefix: "mv_", minLength: 30 },
  { name: "GitHub token", prefix: "ghp_", minLength: 30 },
  { name: "GitHub token", prefix: "github_pat_", minLength: 30 },
  { name: "Anthropic API key", prefix: "sk-ant-", minLength: 30 },
  { name: "AWS access key", prefix: "AKIA", minLength: 16 },
];

// Split so this file doesn't flag itself.
const PRIVATE_KEY_START = "-----BEGIN";
const PRIVATE_KEY_END = ["PRIVATE KEY", "-----"].join("");

function isTokenChar(ch: string): boolean {
  const isLetter = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
  const isDigit = ch >= "0" && ch <= "9";
  return isLetter || isDigit || ch === "_" || ch === "-";
}

/** Length of the run of token characters starting at `from`. */
function tokenLength(text: string, from: number): number {
  let end = from;
  while (end < text.length && isTokenChar(text[end])) {
    end++;
  }
  return end - from;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }
  return line;
}

function findTokens(text: string): string[] {
  const found: string[] = [];
  for (const rule of TOKEN_RULES) {
    let at = text.indexOf(rule.prefix);
    while (at !== -1) {
      const startsWord = at === 0 || !isTokenChar(text[at - 1]);
      if (startsWord && tokenLength(text, at + rule.prefix.length) >= rule.minLength) {
        found.push(`line ${lineNumberAt(text, at)}: looks like a ${rule.name}`);
      }
      at = text.indexOf(rule.prefix, at + 1);
    }
  }
  const keyStart = text.indexOf(PRIVATE_KEY_START);
  if (keyStart !== -1 && text.indexOf(PRIVATE_KEY_END, keyStart) !== -1) {
    found.push(`line ${lineNumberAt(text, keyStart)}: private key`);
  }
  return found;
}

function problemsWithName(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (ALLOWED_NAMES.includes(name)) {
    return null;
  }
  if (FORBIDDEN_NAMES.includes(name)) {
    return "this file holds secrets or private data";
  }
  for (const suffix of FORBIDDEN_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return `${suffix} files usually hold secrets`;
    }
  }
  return null;
}

const problems: string[] = [];
for (const path of stagedFiles()) {
  const nameProblem = problemsWithName(path);
  if (nameProblem) {
    problems.push(`   ${path}: ${nameProblem}`);
    continue;
  }
  const content = readStaged(path);
  if (isBinary(content)) {
    continue;
  }
  for (const finding of findTokens(content.toString("utf8"))) {
    problems.push(`   ${path} ${finding}`);
  }
}

if (problems.length > 0) {
  console.error(
    [
      "",
      "✖ Commit blocked: staged changes look like they contain secrets.",
      "",
      ...problems,
      "",
      "Remove the secret (use an env var or a git-ignored file such as .env), then",
      "unstage the file with `git restore --staged <file>` and commit again.",
      "If it is a fake value in a test, make it shorter than a real token.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
