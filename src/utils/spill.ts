import crypto from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { sliceSafeChars, sliceUtf8Bytes } from "./output-filter.js";
import { getUpdaterPaths } from "./updater-core.js";

export const SPILL_MAX_BYTES = 2 * 1024 * 1024;
export const SPILL_TTL_MS = 24 * 60 * 60 * 1000;
export const SPILL_MAX_FILES = 50;
export const SPILL_FILENAME_REGEX =
  /^[a-z0-9_-]+-\d{8}-\d{6}-[0-9a-f]{6}\.log$/i;

const SPILL_CAP_NOTICE = "\n... [spill file capped at 2 MB]";
const SPILL_CAP_NOTICE_BYTES = Buffer.byteLength(SPILL_CAP_NOTICE, "utf8");

const PEM_BEGIN_PREFIX = "-----BEGIN ";
const PEM_END_PREFIX = "-----END ";
const PEM_KEY_SUFFIX = "PRIVATE KEY-----";
const PEM_MAX_LABEL_LEN = 64;
const PEM_WINDOW_LEN = PEM_MAX_LABEL_LEN + PEM_KEY_SUFFIX.length;
const PEM_LABEL_REGEX = /^[A-Z0-9 ]{0,64}$/;

const TRAILING_TOKEN_DELIMS = new Set([",", ";", ")", '"', "'", "`", ">", "}", "]"]);

const AUTH_BEARER_REGEX = /(Authorization[ \t]*:[ \t]*Bearer[ \t]+)(\S+)/gi;
const BARE_BEARER_REGEX = /(\bBearer[ \t]+)(\S+)/gi;
const GITHUB_CLASSIC_TOKEN_REGEX = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
const GITHUB_PAT_TOKEN_REGEX = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const SK_API_KEY_REGEX = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const GOOGLE_API_KEY_REGEX = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const AWS_ACCESS_KEY_REGEX = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const SLACK_TOKEN_REGEX = /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g;

export interface SpillSectionInput {
  label: string;
  content: string;
  truncated?: boolean;
}

export interface SpillSectionRange {
  label: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export interface WriteSpillFileOptions {
  tool: string;
  sections: SpillSectionInput[];
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}

export interface SpillFileResult {
  filePath: string;
  totalLines: number;
  totalBytes: number;
  capped: boolean;
  sections: SpillSectionRange[];
}

export interface FormatSpillFooterOptions {
  maxChars?: number;
  maxBytes?: number;
  maxRanges?: number;
}

function parseSpillToggle(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const norm = raw.trim().toLowerCase();
  if (norm === "off" || norm === "0" || norm === "false") return false;
  if (norm === "on" || norm === "1" || norm === "true") return true;
  return null;
}

export function getSpillDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getUpdaterPaths(env).cacheDir, "spill");
}

/**
 * Spill enable precedence:
 * 1. `env.AGY_FAST_SPILL` ("off"|"0"|"false" -> false; "on"|"1"|"true" -> true)
 * 2. `<cacheDir>/config.json` key `spill` ("off"|false -> false; "on"|true -> true)
 * 3. Default: true (lazy-on)
 */
export function isSpillEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const envVal = parseSpillToggle(env.AGY_FAST_SPILL);
  if (envVal !== null) return envVal;

  try {
    const { configFile } = getUpdaterPaths(env);
    const raw = readFileSync(configFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cfgVal = parseSpillToggle((parsed as { spill?: unknown }).spill);
      if (cfgVal !== null) return cfgVal;
    }
  } catch {
    // Missing or unreadable config.json: fail-open to default on
  }

  return true;
}

function splitTrailingTokenDelims(token: string): [string, string] {
  let end = token.length;
  while (end > 0 && TRAILING_TOKEN_DELIMS.has(token[end - 1]!)) {
    end--;
  }
  return [token.slice(0, end), token.slice(end)];
}

/**
 * Strictly O(n) linear-time PEM private key block redactor using indexOf scans
 * (zero multiline regex backtracking).
 */
function redactPemPrivateKeys(text: string): string {
  const firstBegin = text.indexOf(PEM_BEGIN_PREFIX);
  if (firstBegin === -1) return text;
  const firstEnd = text.indexOf(PEM_END_PREFIX, firstBegin + PEM_BEGIN_PREFIX.length);
  if (firstEnd === -1) return text;

  // Pass 1: index all valid `-----END <label>PRIVATE KEY-----` markers in strict O(n)
  const endMarkersByLabel = new Map<string, { offsets: number[]; ptr: number }>();
  let endPos = firstEnd;
  while (endPos !== -1) {
    const contentStart = endPos + PEM_END_PREFIX.length;
    const relSuffix = text
      .slice(contentStart, contentStart + PEM_WINDOW_LEN)
      .indexOf(PEM_KEY_SUFFIX);
    if (relSuffix !== -1) {
      const label = text.slice(contentStart, contentStart + relSuffix);
      if (PEM_LABEL_REGEX.test(label)) {
        let bucket = endMarkersByLabel.get(label);
        if (!bucket) {
          bucket = { offsets: [], ptr: 0 };
          endMarkersByLabel.set(label, bucket);
        }
        bucket.offsets.push(endPos);
        endPos = text.indexOf(
          PEM_END_PREFIX,
          contentStart + relSuffix + PEM_KEY_SUFFIX.length,
        );
        continue;
      }
    }
    endPos = text.indexOf(PEM_END_PREFIX, contentStart);
  }

  if (endMarkersByLabel.size === 0) return text;

  // Pass 2: linearly match each `-----BEGIN <label>PRIVATE KEY-----` to the next matching END
  const chunks: string[] = [];
  let cursor = 0;
  let beginPos = firstBegin;
  while (beginPos !== -1) {
    const contentStart = beginPos + PEM_BEGIN_PREFIX.length;
    const relSuffix = text
      .slice(contentStart, contentStart + PEM_WINDOW_LEN)
      .indexOf(PEM_KEY_SUFFIX);
    if (relSuffix !== -1) {
      const label = text.slice(contentStart, contentStart + relSuffix);
      if (PEM_LABEL_REGEX.test(label)) {
        const headerEnd = contentStart + relSuffix + PEM_KEY_SUFFIX.length;
        const bucket = endMarkersByLabel.get(label);
        if (bucket) {
          while (
            bucket.ptr < bucket.offsets.length &&
            bucket.offsets[bucket.ptr]! < headerEnd
          ) {
            bucket.ptr++;
          }
          if (bucket.ptr < bucket.offsets.length) {
            const matchedEnd = bucket.offsets[bucket.ptr]!;
            bucket.ptr++;
            const blockEnd =
              matchedEnd + PEM_END_PREFIX.length + label.length + PEM_KEY_SUFFIX.length;
            chunks.push(text.slice(cursor, beginPos), "[REDACTED PRIVATE KEY]");
            cursor = blockEnd;
            beginPos = text.indexOf(PEM_BEGIN_PREFIX, cursor);
            continue;
          }
        }
      }
    }
    beginPos = text.indexOf(PEM_BEGIN_PREFIX, contentStart);
  }

  if (chunks.length === 0) return text;
  chunks.push(text.slice(cursor));
  return chunks.join("");
}

/**
 * Strictly O(n) linear-time secret redaction for spilled output logs.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = redactPemPrivateKeys(text);

  out = out.replace(AUTH_BEARER_REGEX, (full, prefix: string, token: string) => {
    if (token.startsWith("[REDACTED]")) return full;
    const [core, trail] = splitTrailingTokenDelims(token);
    if (!core) return full;
    return `${prefix}[REDACTED]${trail}`;
  });

  out = out.replace(BARE_BEARER_REGEX, (full, prefix: string, token: string) => {
    if (token.startsWith("[REDACTED]")) return full;
    const [core, trail] = splitTrailingTokenDelims(token);
    if (core.length < 16) return full;
    return `${prefix}[REDACTED]${trail}`;
  });

  out = out.replace(GITHUB_CLASSIC_TOKEN_REGEX, "[REDACTED]");
  out = out.replace(GITHUB_PAT_TOKEN_REGEX, "[REDACTED]");
  out = out.replace(SK_API_KEY_REGEX, "[REDACTED]");
  out = out.replace(GOOGLE_API_KEY_REGEX, "[REDACTED]");
  out = out.replace(AWS_ACCESS_KEY_REGEX, "[REDACTED]");
  out = out.replace(SLACK_TOKEN_REGEX, "[REDACTED]");

  return out;
}

function sanitizeToolName(tool: string): string {
  const cleaned = tool
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "tool").slice(0, 32);
}

function sanitizeSectionLabel(label: string): string {
  const cleaned = label.replace(/[\r\n]+/g, " ").trim();
  return cleaned || "section";
}

function formatUtcTimestamp(nowMs: number): string {
  const d = new Date(nowMs);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

async function ensureSafeSpillDir(spillDir: string): Promise<boolean> {
  const cacheDir = path.dirname(spillDir);
  try {
    const parentSt = await fs.lstat(cacheDir);
    if (parentSt.isSymbolicLink() || !parentSt.isDirectory()) {
      return false;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return false;
    }
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const postParentSt = await fs.lstat(cacheDir);
    if (postParentSt.isSymbolicLink() || !postParentSt.isDirectory()) {
      return false;
    }
  }

  try {
    const st = await fs.lstat(spillDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return false;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return false;
    }
    await fs.mkdir(spillDir, { recursive: true, mode: 0o700 });
    const postSt = await fs.lstat(spillDir);
    if (postSt.isSymbolicLink() || !postSt.isDirectory()) {
      return false;
    }
  }
  await fs.chmod(spillDir, 0o700).catch(() => {});
  return true;
}

async function cleanupSpillDir(
  spillDir: string,
  keepFileName: string,
  nowMs: number,
): Promise<void> {
  try {
    const names = await fs.readdir(spillDir);
    const survivors: Array<{ name: string; fullPath: string; mtimeMs: number }> = [];

    for (const name of names) {
      if (!SPILL_FILENAME_REGEX.test(name)) continue;
      if (name === keepFileName) continue;
      const fullPath = path.join(spillDir, name);
      let st;
      try {
        st = await fs.lstat(fullPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) continue;
      if (nowMs - st.mtimeMs > SPILL_TTL_MS) {
        await fs.unlink(fullPath).catch(() => {});
      } else {
        survivors.push({ name, fullPath, mtimeMs: st.mtimeMs });
      }
    }

    // Reserve 1 slot for the freshly written `keepFileName`
    const maxOtherFiles = Math.max(0, SPILL_MAX_FILES - 1);
    if (survivors.length > maxOtherFiles) {
      survivors.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
      const removeCount = survivors.length - maxOtherFiles;
      for (let i = 0; i < removeCount; i++) {
        await fs.unlink(survivors[i]!.fullPath).catch(() => {});
      }
    }
  } catch {
    // Best-effort, fail-open
  }
}

export async function writeSpillFile(
  options: WriteSpillFileOptions,
): Promise<SpillFileResult | null> {
  const env = options.env ?? process.env;
  if (!isSpillEnabled(env) || options.sections.length === 0) {
    return null;
  }

  try {
    const nowMs =
      typeof options.nowMs === "number" && Number.isFinite(options.nowMs)
        ? options.nowMs
        : Date.now();
    const spillDir = getSpillDir(env);
    const dirOk = await ensureSafeSpillDir(spillDir);
    if (!dirOk) return null;

    const blocks: string[] = [];
    const ranges: SpillSectionRange[] = [];
    let currentLine = 1;

    for (const sec of options.sections) {
      const label = sanitizeSectionLabel(sec.label);
      const redacted = redactSecrets(sec.content)
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
      const body = redacted.endsWith("\n") ? redacted.slice(0, -1) : redacted;
      const block = `=== ${label} ===\n${body}`;
      const blockLines = block.split("\n").length;
      const startLine = currentLine;
      const endLine = currentLine + blockLines - 1;
      blocks.push(block);
      ranges.push({
        label,
        startLine,
        endLine,
        truncated: Boolean(sec.truncated),
      });
      // "\n\n" separator adds 1 blank line between sections
      currentLine = endLine + 2;
    }

    let finalContent = blocks.join("\n\n");
    let capped = false;
    let totalBytes = Buffer.byteLength(finalContent, "utf8");

    if (totalBytes > SPILL_MAX_BYTES) {
      const maxPrefixBytes = Math.max(0, SPILL_MAX_BYTES - SPILL_CAP_NOTICE_BYTES);
      const prefix = sliceUtf8Bytes(finalContent, maxPrefixBytes);
      const cutChar = finalContent.charAt(prefix.length);
      const prefixLines = prefix.split("\n").length;
      finalContent = `${prefix}${SPILL_CAP_NOTICE}`;
      totalBytes = Buffer.byteLength(finalContent, "utf8");
      capped = true;
      const finalTotalLines = finalContent.split("\n").length;
      for (const r of ranges) {
        if (
          r.endLine > prefixLines ||
          (r.endLine === prefixLines && cutChar !== "" && cutChar !== "\n")
        ) {
          r.truncated = true;
        }
        r.startLine = Math.min(r.startLine, finalTotalLines);
        r.endLine = Math.min(r.endLine, finalTotalLines);
      }
    }

    const totalLines = finalContent.split("\n").length;
    const safeTool = sanitizeToolName(options.tool);
    const ts = formatUtcTimestamp(nowMs);

    let fileName = "";
    let filePath = "";
    let written = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const hex = crypto.randomBytes(3).toString("hex");
      fileName = `${safeTool}-${ts}-${hex}.log`;
      filePath = path.join(spillDir, fileName);
      try {
        await fs.writeFile(filePath, finalContent, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        written = true;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
          continue;
        }
        throw err;
      }
    }
    if (!written) return null;

    await fs.chmod(filePath, 0o600).catch(() => {});
    await cleanupSpillDir(spillDir, fileName, nowMs);

    return {
      filePath,
      totalLines,
      totalBytes,
      capped,
      sections: ranges,
    };
  } catch {
    return null;
  }
}

function formatShortLabel(label: string, maxLen = 28): string {
  const clean = label.replace(/\s+/g, " ").trim() || "section";
  if (clean.length <= maxLen) return clean;
  return `${sliceSafeChars(clean, Math.max(1, maxLen - 3))}...`;
}

function fitsFooterCaps(
  footer: string,
  maxChars: number | undefined,
  maxBytes: number | undefined,
): boolean {
  if (maxChars !== undefined && footer.length > maxChars) return false;
  if (maxBytes !== undefined && Buffer.byteLength(footer, "utf8") > maxBytes) return false;
  return true;
}

export function formatSpillFooter(
  result: SpillFileResult,
  opts: FormatSpillFooterOptions = {},
): string {
  const maxRanges = Math.max(1, Math.trunc(opts.maxRanges ?? 4));
  const explicitCap = opts.maxChars !== undefined || opts.maxBytes !== undefined;
  const effectiveMaxChars = opts.maxChars ?? 480;
  const effectiveMaxBytes = opts.maxBytes;

  const truncated = result.sections.filter((s) => s.truncated);
  const candidates = truncated.length > 0 ? truncated : result.sections;

  const baseHead = `\n[full output spilled: ${result.filePath} (${result.totalLines} lines)`;
  const minimalFooter = `${baseHead}]`;

  if (candidates.length > 0) {
    const startCount = Math.min(maxRanges, candidates.length);
    for (let count = startCount; count >= 1; count--) {
      const shown = candidates.slice(0, count);
      const extra = candidates.length - count;
      const parts = shown.map(
        (s) => `${formatShortLabel(s.label)} L${s.startLine}-L${s.endLine}`,
      );
      if (extra > 0) {
        parts.push(`+${extra} more`);
      }
      const candidate = `${baseHead} — read_file ranges: ${parts.join(", ")}]`;
      if (fitsFooterCaps(candidate, effectiveMaxChars, effectiveMaxBytes)) {
        return candidate;
      }
    }
  }

  if (!explicitCap || fitsFooterCaps(minimalFooter, opts.maxChars, opts.maxBytes)) {
    return minimalFooter;
  }

  return "";
}
