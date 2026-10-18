// Vault-relative paths always use "/" and never start or end with one.

export function normalizePath(path: string): string {
  const parts = path.split("\\").join("/").split("/");
  return parts.filter((part) => part !== "").join("/");
}

export function isSafePath(path: string): boolean {
  if (path === "" || path.includes("\0") || path.startsWith("/")) {
    return false;
  }
  // Windows drive letter, e.g. "C:"
  if (path.length >= 2 && path[1] === ":") {
    return false;
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return false;
    }
  }
  return true;
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Lower-case extension without the dot, or "" when there is none. */
export function extensionOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
}

const MERGEABLE_EXTENSIONS = ["md", "markdown", "txt"];
const MARKDOWN_EXTENSIONS = ["md", "markdown"];

/** Text formats the server will 3-way merge line by line. */
export function isMergeable(path: string): boolean {
  return MERGEABLE_EXTENSIONS.includes(extensionOf(path));
}

export function isMarkdown(path: string): boolean {
  return MARKDOWN_EXTENSIONS.includes(extensionOf(path));
}

const UNSAFE_NAME_CHARS = '\\/:*?"<>|#^[]';

function sanitizeDeviceName(device: string): string {
  let out = "";
  for (const ch of device) {
    if (!UNSAFE_NAME_CHARS.includes(ch)) {
      out += ch;
    }
  }
  out = out.trim().slice(0, 40);
  if (out === "") {
    return "unknown";
  }
  return out;
}

/** "Notes/Plan.md" → "Notes/Plan (conflict Phone 2026-10-18 15-30-12).md" */
export function conflictPath(path: string, device: string, date = new Date()): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  let stem = name;
  let ext = "";
  if (dot > 0) {
    stem = name.slice(0, dot);
    ext = name.slice(dot);
  }
  // "2026-10-18T15:30:12.000Z" → "2026-10-18 15-30-12"
  const stamp = date.toISOString().slice(0, 19).replace("T", " ").replaceAll(":", "-");
  return `${dir}${stem} (conflict ${sanitizeDeviceName(device)} ${stamp})${ext}`;
}

/**
 * Glob match without regular expressions.
 *   `*`  any characters except "/"
 *   `**` any characters including "/"; followed by a slash it also matches zero folders
 *   `?`  one character except "/"
 */
export function matchGlob(pattern: string, text: string): boolean {
  return matchFrom(pattern, 0, text, 0);
}

function matchFrom(pattern: string, p: number, text: string, t: number): boolean {
  while (p < pattern.length) {
    const ch = pattern[p];

    if (ch === "*" && pattern[p + 1] === "*") {
      const rest = p + 2;
      if (pattern[rest] === "/" && matchFrom(pattern, rest + 1, text, t)) {
        return true;
      }
      for (let k = t; k <= text.length; k++) {
        if (matchFrom(pattern, rest, text, k)) {
          return true;
        }
      }
      return false;
    }

    if (ch === "*") {
      for (let k = t; k <= text.length; k++) {
        if (matchFrom(pattern, p + 1, text, k)) {
          return true;
        }
        if (text[k] === "/") {
          return false;
        }
      }
      return false;
    }

    if (t >= text.length) {
      return false;
    }
    if (ch === "?") {
      if (text[t] === "/") {
        return false;
      }
    } else if (ch !== text[t]) {
      return false;
    }
    p++;
    t++;
  }
  return t === text.length;
}

interface Rule {
  pattern: string;
  /** Pattern had no "/" – match it against each path segment on its own. */
  matchSegment: boolean;
  /** Pattern ended with "/" – only matches folders. */
  foldersOnly: boolean;
}

function trimSlashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === "/") {
    start++;
  }
  while (end > start && s[end - 1] === "/") {
    end--;
  }
  return s.slice(start, end);
}

/**
 * gitignore-flavoured exclude list:
 *   `name`      any file or folder called name, at any depth
 *   `folder/`   folders only
 *   `/a/b.md`   anchored to the vault root
 *   `*`, `**`, `?` globs
 */
export class PathFilter {
  private rules: Rule[] = [];

  constructor(patterns: string[]) {
    for (const raw of patterns) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) {
        continue;
      }
      const foldersOnly = line.endsWith("/");
      const pattern = trimSlashes(line);
      // "name" matches at any depth; "/name" or "a/name" are anchored to the vault root.
      const matchSegment = !pattern.includes("/") && !line.startsWith("/");
      this.rules.push({ pattern, matchSegment, foldersOnly });
    }
  }

  /** True when `path` or any folder above it matches a rule. */
  excludes(path: string, isFolder = false): boolean {
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      const prefix = segments.slice(0, i + 1).join("/");
      const segmentIsFolder = i < segments.length - 1 || isFolder;
      for (const rule of this.rules) {
        if (rule.foldersOnly && !segmentIsFolder) {
          continue;
        }
        let candidate = prefix;
        if (rule.matchSegment) {
          candidate = segments[i];
        }
        if (matchGlob(rule.pattern, candidate)) {
          return true;
        }
      }
    }
    return false;
  }
}

/** Never synced by anyone. */
export const DEFAULT_EXCLUDES = [
  ".git/",
  ".trash/",
  "node_modules/",
  ".DS_Store",
  "Thumbs.db",
  "*.mcpvault-tmp",
];

export interface ClientFilterOptions {
  /** Obsidian's config folder, usually ".obsidian". */
  configDir: string;
  syncConfig: boolean;
  /** This plugin's own folder inside configDir – its settings and sync state are per device. */
  pluginDir?: string;
  excludes?: string[];
}

export interface SyncFilter {
  allows(path: string): boolean;
  allowsFolder(path: string): boolean;
}

/**
 * Obsidian ignores dot-files, so a client must never claim them: it can't see them and would
 * report them as deleted. The config folder is the one exception, and only when enabled.
 */
export function createClientFilter(options: ClientFilterOptions): SyncFilter {
  const configDir = options.configDir;
  const patterns = [
    ...DEFAULT_EXCLUDES,
    ...(options.excludes ?? []),
    `/${configDir}/workspace.json`,
    `/${configDir}/workspace-mobile.json`,
    `/${configDir}/workspaces.json`,
    `/${configDir}/cache/`,
  ];
  if (options.pluginDir) {
    patterns.push(`/${options.pluginDir}/data.json`, `/${options.pluginDir}/sync-state.json`);
  }
  const filter = new PathFilter(patterns);

  function hiddenAllowed(path: string): boolean {
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      if (!segments[i].startsWith(".")) {
        continue;
      }
      const isConfigRoot = i === 0 && segments[i] === configDir;
      if (!isConfigRoot || !options.syncConfig) {
        return false;
      }
    }
    return true;
  }

  return {
    allows(path) {
      return isSafePath(path) && hiddenAllowed(path) && !filter.excludes(path);
    },
    allowsFolder(path) {
      return hiddenAllowed(path) && !filter.excludes(path, true);
    },
  };
}
