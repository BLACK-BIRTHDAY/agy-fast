// Matches standard ANSI CSI / OSC escape sequences
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * Clean terminal carriage-return progress overwrites so only the final frame of
 * each line remains.
 */
export function normalizeTerminalOutput(raw: string): string {
  const clean = stripAnsi(raw).replace(/\r\n/g, "\n");
  return clean
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r").filter((p) => p.length > 0);
      return parts[parts.length - 1] ?? "";
    })
    .join("\n")
    .trimEnd();
}

/**
 * Antigravity spills call_mcp_tool responses over ~10 KB UTF-8 to disk
 * (`The output was large and was saved to: ...`), forcing an extra LLM turn
 * to read_file(output.txt). Keeping default tool responses <= 8,800 UTF-8 bytes
 * guarantees inline delivery with headroom for timestamp/JSON wrappers.
 */
export const DEFAULT_INLINE_MAX_BYTES = 8_800;

export function sliceUtf8Bytes(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let bytes = 0;
  let endIndex = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const unitLen = cp > 0xffff ? 2 : 1;
    const chBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + chBytes > limit) break;
    bytes += chBytes;
    i += unitLen;
    endIndex = i;
  }
  return text.slice(0, endIndex);
}

export function truncateWithByteNotice(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= limit) return text;

  if (limit < 56) {
    if (limit <= 3) return sliceUtf8Bytes(text, limit);
    return `${sliceUtf8Bytes(text, limit - 3)}...`;
  }

  const maxNoticeBytes = Buffer.byteLength(
    `\n... [truncated: showed ${totalBytes} of ${totalBytes} bytes]`,
    "utf8",
  );
  const cutoffBytes = Math.max(0, limit - maxNoticeBytes);
  let slice = sliceUtf8Bytes(text, cutoffBytes);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0 && Buffer.byteLength(slice.slice(0, lastNewline), "utf8") > cutoffBytes * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const shownBytes = Buffer.byteLength(slice, "utf8");
  const result = `${slice}\n... [truncated: showed ${shownBytes} of ${totalBytes} bytes]`;
  return Buffer.byteLength(result, "utf8") <= limit
    ? result
    : sliceUtf8Bytes(result, limit);
}

export function sliceSafeChars(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let end = limit;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

export function truncateWithNotice(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;

  if (limit < 48) {
    if (limit <= 3) return sliceSafeChars(text, limit);
    return `${sliceSafeChars(text, limit - 3)}...`;
  }

  const maxNoticeLen = `\n... [truncated: showed ${text.length} of ${text.length} chars]`.length;
  const cutoff = Math.max(0, limit - maxNoticeLen);
  let slice = sliceSafeChars(text, cutoff);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > cutoff * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const result = `${slice}\n... [truncated: showed ${slice.length} of ${text.length} chars]`;
  return result.length <= limit ? result : sliceSafeChars(result, limit);
}

export function sliceTailSafeChars(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let start = text.length - limit;
  const firstCode = text.charCodeAt(start);
  if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
    start += 1;
  }
  return text.slice(start);
}

/**
 * Pure water-filling budget allocator: items smaller than the current fair
 * share keep their exact size and donate 100% of their unused share to larger
 * items. Sum of returned budgets equals min(sum(sizes), totalBudget).
 */
export function computeWaterFillBudgets(
  sizes: number[],
  totalBudget: number,
): number[] {
  if (sizes.length === 0) return [];
  const budgets = new Array<number>(sizes.length).fill(0);
  if (!Number.isFinite(totalBudget) || totalBudget <= 0) return budgets;

  let remainingBudget = Math.trunc(totalBudget);
  if (remainingBudget <= 0) return budgets;

  const order = sizes
    .map((raw, idx) => ({
      idx,
      size: Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0,
    }))
    .sort((a, b) => a.size - b.size || a.idx - b.idx);

  for (let i = 0; i < order.length; i++) {
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBudget / remainingCount);
    const item = order[i]!;
    if (item.size <= share) {
      budgets[item.idx] = item.size;
      remainingBudget -= item.size;
    } else {
      for (let j = i; j < order.length; j++) {
        const rem = order.length - j;
        const alloc = Math.floor(remainingBudget / rem);
        budgets[order[j]!.idx] = alloc;
        remainingBudget -= alloc;
      }
      break;
    }
  }

  return budgets;
}

/**
 * Water-filling character budget allocator: short sections keep their full
 * text, and remaining budget is split evenly among longer sections so total
 * joined length stays strictly within maxChars.
 */
export function fitSectionsToBudget(
  sections: string[],
  maxChars: number,
  separator = "\n\n",
): string {
  if (sections.length === 0 || !Number.isFinite(maxChars) || maxChars <= 0) return "";
  const joined = sections.join(separator);
  if (joined.length <= maxChars) return joined;

  const sepTotal = separator.length * (sections.length - 1);
  if (sepTotal >= maxChars) {
    return truncateWithNotice(joined, maxChars);
  }

  const budgets = computeWaterFillBudgets(
    sections.map((s) => s.length),
    maxChars - sepTotal,
  );

  const fitted = sections
    .map((sec, idx) => truncateWithNotice(sec, budgets[idx] ?? 0))
    .join(separator);
  return fitted.length <= maxChars ? fitted : truncateWithNotice(fitted, maxChars);
}

/**
 * Fits sections within both a character budget and an optional UTF-8 byte
 * budget (water-filling by UTF-8 byte size when CJK/multi-byte characters
 * push the joined string over maxBytes).
 */
export function fitSectionsToByteBudget(
  sections: string[],
  maxChars: number,
  maxBytes?: number,
  separator = "\n\n",
): string {
  const charFitted = fitSectionsToBudget(sections, maxChars, separator);
  if (maxBytes === undefined) {
    return charFitted;
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  if (Buffer.byteLength(charFitted, "utf8") <= maxBytes) {
    return charFitted;
  }

  const sepBytes = Buffer.byteLength(separator, "utf8") * (sections.length - 1);
  if (sepBytes >= maxBytes) {
    return truncateWithByteNotice(charFitted, maxBytes);
  }

  const byteBudgets = computeWaterFillBudgets(
    sections.map((s) => Buffer.byteLength(s, "utf8")),
    maxBytes - sepBytes,
  );

  let fitted = sections
    .map((sec, idx) => truncateWithByteNotice(sec, byteBudgets[idx] ?? 0))
    .join(separator);
  if (fitted.length > maxChars) {
    fitted = truncateWithNotice(fitted, maxChars);
  }
  return Buffer.byteLength(fitted, "utf8") <= maxBytes
    ? fitted
    : truncateWithByteNotice(fitted, maxBytes);
}

/**
 * Benign zero-count phrases (e.g. "0 errors", "errors: 0", "0 failed",
 * "failed: 0", "0 failures", "0 warnings") stripped prior to error/danger
 * matching so passing summary counts never trigger false positives.
 */
const BENIGN_ZERO_COUNT_PATTERN =
  /\b(?:(?:0|no)\s+(?:errors?|warnings?|fail(?:ed|ures?|ing)?)(?:\(s\))?|(?:errors|error\(s\)|warnings|warning\(s\)|fail(?:ed|ures|ure\(s\)|ing)?)\s*(?::|=|\()\s*0\b(?!\.\d)\)?)/gi;

function stripBenignZeroCounts(line: string): string {
  return line.replace(BENIGN_ZERO_COUNT_PATTERN, " ");
}

const ERROR_LINE_PATTERN =
  /(?:\berr!|\b(?:errors?|fail(?:ed|ing|ure|ures)?|exception|traceback|panic|fatal|assertion|syntaxerror|typeerror|referenceerror|zoderror|validationerror|ts\d{4}|e\d{4}|cannot find|not found|unexpected|undefined)\b|caused by:|application failed to start|compilation error|<<<\s*(?:failure|error)|找不到符号|符号:|位置:)/i;

const ROOT_CAUSE_HEADER_PATTERN =
  /(?:^\s*(?:description|action):|caused by:|application failed to start|⎯\s*failed tests|compilation error)/i;

const FOLD_DANGER_TOKEN_PATTERN =
  /(?:\berr!|\b(?:errors?|fail(?:ed|ing|ure|ures)?|warns?|warnings?|exceptions?|tracebacks?|panics?|fatals?|assertions?|syntaxerror|typeerror|referenceerror|zoderror|validationerror|ts\d{4}|cannot find|not found|compilation error)\b|caused by:|application failed to start|<<<\s*(?:failure|error)|[✖✘✗×]\s+)/i;

function isErrorLine(line: string): boolean {
  return ERROR_LINE_PATTERN.test(stripBenignZeroCounts(line));
}

function hasFoldDangerToken(line: string): boolean {
  return FOLD_DANGER_TOKEN_PATTERN.test(stripBenignZeroCounts(line));
}

const JSON_INFO_LOG_PATTERNS: RegExp[] = [
  /^\s*\{"level":(?:10|20|30)\b/,
  /^\s*\{[^}]*"level"\s*:\s*"(?:trace|debug|info)"/i,
];

const ALWAYS_NOISE_LINE_PATTERNS: RegExp[] = [
  /^\[ERROR\]\s*(?:To see the full stack trace|Re-run Maven using the -X|For more information about the errors|\[Help \d+\]|->\s*\[Help \d+\])/i,
  /^\(node:\d+\)\s*ExperimentalWarning:/,
  /^\(Use `node --trace-warnings/,
];

function isFailureNoiseLine(line: string): boolean {
  if (ALWAYS_NOISE_LINE_PATTERNS.some((re) => re.test(line))) return true;
  if (JSON_INFO_LOG_PATTERNS.some((re) => re.test(line))) {
    // Never strip a structured log line if it reports an actual 5xx/error/exception
    return !/"statusCode"\s*:\s*5\d\d|\b(?:error|exception|failed|fatal)\b/i.test(
      stripBenignZeroCounts(line),
    );
  }
  return false;
}

const SUMMARY_LINE_PATTERN =
  /\b(passed|tests?|specs?|suites?|ok|warnings?|errors?|built in|compiled|done in|finished)\b/i;

const MONOREPO_PREFIX_PATTERN =
  /^(?:@[\w.-]+\/)?[\w./-]+(?::[A-Za-z][\w.-]*|\s+[A-Za-z][\w.-]*):\s+/;

const GREEN_BUILD_OR_PASS_PATTERNS: RegExp[] = [
  // Vite / Rollup / esbuild / Webpack / bundler banners & asset size lines
  /^(?:vite|rollup|esbuild|webpack|rspack|parcel|tsup|rolldown)\s+v?\d[\w.-]*\b/i,
  /^transforming(?:\.\.\.|\s*\(\d+\).*|\s+\d+\s+modules?)?$/i,
  /^(?:[✓✔]\s*)?\d+\s+modules?\s+transformed\.?$/i,
  /^(?:rendering chunks|computing (?:gzip|brotli) size|building (?:for |SSR )?production|bundling|minifying|emitting assets)(?:\.{0,3})$/i,
  /^(?:\.\.?\/)?(?:dist|build|out|\.next|\.output|public|assets|lib)\/\S+\s+\d+(?:\.\d+)?\s*(?:B|kB|KB|MB|GB|KiB|MiB|bytes)\b/i,
  /^\S+\.(?:m?js|cjs|css|html|svg|png|woff2?|json|map|wasm)\s+\d+(?:\.\d+)?\s*(?:B|kB|KB|MB|GB|KiB|MiB)(?:\s+[│|]\s*(?:gzip|brotli|map):|\s*$)/i,
  /^(?:[✓✔⚡]\s*)?built\b.*(?:\bin\s{1,4}\d+(?:\.\d+)?\s{0,4}(?:ms|s|m)\b|\(\s{0,4}\d+(?:\.\d+)?\s{0,4}(?:B|KB|kB|MB|GB|KiB|MiB)\s{0,4}\))/i,
  /^(?:[✓✔⚡]\s*)?(?:done in\s+\d+(?:\.\d+)?\s*(?:ms|s|m)\.?|build (?:succeeded|completed|finished)\b|compiled successfully\b|bundle created\b)/i,
  /^(?:asset|chunk|orphan modules|runtime modules|cacheable modules)\s+\S.*\b(?:bytes|KiB|MiB|kB|KB|MB|modules?)\b/i,
  // npm / pnpm / yarn / turbo script & workspace banners
  /^>\s+(?:@[\w.-]+\/)?[\w.-]+@[\w.+-]+(?:\s|$)/,
  /^>\s+(?:vite|tsc|esbuild|rollup|webpack|rspack|tsup|unbuild|next|nuxt|astro|svelte-kit|vitest|jest|mocha|pnpm|npm|yarn|turbo|nx|node|tsx)\b/,
  /^(?:@[\w.-]+\/)?[\w./-]+\s+[A-Za-z][\w.-]*\$\s+\S/,
  /^Scope:\s+\d+\s+of\s+\d+\s+workspace projects\b/i,
  /^Tasks:\s+\d+\s+successful\b/i,
  /^Cached:\s+\d+\s+cached\b/i,
  /^cache hit,\s+replaying logs\b/i,
  /^Time:\s+\d+(?:\.\d+)?\s*(?:ms|s|m)\b/i,
  /^(?:yarn run v\d|•\s+Packages in scope:|•\s+Running\s+\S+\s+in\s+\d+\s+packages)/i,
  // Test pass lines (Vitest / Jest / Mocha / Node / Go / Cargo / TAP)
  /^[✓✔]\s+\S/,
  /^PASS\s+\S/,
  /^(?:---\s+PASS:\s*|===\s+(?:RUN|PAUSE|CONT)\s+)\S/,
  /^ok\t\S/,
  /^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))/i,
  /^ok\s+\d+\s+-\s+\S/,
  /^test\s+\S+\s+\.\.\.\s+ok\b/,
  /^running\s+\d+\s+tests?$/i,
  /^(?:Test Files|Tests|Suites|Snapshots|Start at|Duration|test result:\s{0,4}ok\.)\s.*(?:\bpassed\b|\btotal\b|\b\d+(?:\.\d+)?(?:ms|s)\b|\bok\.)/i,
  // Rust / Go / Gradle / Maven progress
  /^(?:Compiling|Checking|Downloading|Downloaded|Updating|Fresh|Locking|Packaging|Documenting|Finished)\s+\S/,
  /^go:\s+downloading\s+\S/,
  /^>\s+Task\s+:[\w:.-]+\s+(?:UP-TO-DATE|FROM-CACHE|NO-SOURCE|SKIPPED)\s*$/,
  /^\[INFO\]/,
];

const MIN_FOLD_RUN_LINES = 4;
const PROTECTED_TAIL_LINES = 15;

function isGreenBuildOrPassLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (hasFoldDangerToken(trimmed)) return false;

  if (GREEN_BUILD_OR_PASS_PATTERNS.some((re) => re.test(trimmed))) {
    return true;
  }

  const prefixMatch = MONOREPO_PREFIX_PATTERN.exec(trimmed);
  if (prefixMatch) {
    const inner = trimmed.slice(prefixMatch[0].length).trim();
    if (!inner) return false;
    if (inner === "Done") return true;
    return GREEN_BUILD_OR_PASS_PATTERNS.some((re) => re.test(inner));
  }

  return false;
}

function formatLastCollapsedPreview(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= 120) return trimmed;
  return `${sliceSafeChars(trimmed, 117)}...`;
}

/**
 * Proactively collapses contiguous runs (>= 4 non-empty matching lines) of known
 * green build/pass progress lines outside the protected final 15 lines.
 * Unknown lines and any line carrying real error/fail/warn/exception/panic/fatal
 * tokens are always preserved verbatim.
 */
function foldGreenBuildPhaseLines(lines: string[]): {
  lines: string[];
  collapsedLines: number;
} {
  const foldableEnd = Math.max(0, lines.length - PROTECTED_TAIL_LINES);
  if (foldableEnd < MIN_FOLD_RUN_LINES) {
    return { lines, collapsedLines: 0 };
  }

  const out: string[] = [];
  let collapsedLines = 0;
  let i = 0;

  while (i < foldableEnd) {
    if (!isGreenBuildOrPassLine(lines[i]!)) {
      out.push(lines[i]!);
      i++;
      continue;
    }

    const start = i;
    let lastGreen = i;
    let greenCount = 1;
    i++;

    while (i < foldableEnd) {
      const cur = lines[i]!;
      if (isGreenBuildOrPassLine(cur)) {
        lastGreen = i;
        greenCount++;
        i++;
      } else if (cur.trim() === "") {
        // Allow blank lines to bridge contiguous green build phases;
        // trailing blanks after lastGreen are not absorbed.
        i++;
      } else {
        break;
      }
    }

    if (greenCount >= MIN_FOLD_RUN_LINES) {
      const runLen = lastGreen - start + 1;
      out.push(
        `... (collapsed ${runLen} build/pass lines; last: ${formatLastCollapsedPreview(lines[lastGreen]!)})`,
      );
      collapsedLines += runLen;
      i = lastGreen + 1;
    } else {
      for (let j = start; j <= lastGreen; j++) {
        out.push(lines[j]!);
      }
      i = lastGreen + 1;
    }
  }

  for (let j = foldableEnd; j < lines.length; j++) {
    out.push(lines[j]!);
  }

  return { lines: out, collapsedLines };
}

function renderSelectedIndices(
  lines: string[],
  indices: number[],
  leadingOmission: boolean,
): string {
  if (indices.length === 0) return "";
  const out: string[] = [];
  if (leadingOmission && indices[0]! > 0) {
    out.push(`... (${indices[0]!} lines omitted) ...`);
  }
  let prev = -1;
  for (const idx of indices) {
    if (prev !== -1 && idx > prev + 1) {
      out.push(`... (${idx - prev - 1} lines omitted) ...`);
    }
    out.push(lines[idx]!);
    prev = idx;
  }
  return out.join("\n");
}

function packTailIndices(
  lines: string[],
  candidates: number[],
  budget: number,
  leadingOmission: boolean,
): { indices: number[]; text: string } {
  if (candidates.length === 0 || budget <= 0) {
    return { indices: [], text: "" };
  }

  const chosenRev: number[] = [];
  let usedChars = 0;

  for (let k = candidates.length - 1; k >= 0; k--) {
    const idx = candidates[k]!;
    const lineLen = lines[idx]!.length;
    let add = lineLen;
    if (chosenRev.length > 0) {
      const nextIdx = chosenRev[chosenRev.length - 1]!;
      if (nextIdx > idx + 1) {
        const gapMarkerLen = `... (${nextIdx - idx - 1} lines omitted) ...`.length;
        add = lineLen + 1 + gapMarkerLen + 1;
      } else {
        add = lineLen + 1;
      }
    }
    const headerLen =
      leadingOmission && idx > 0 ? `... (${idx} lines omitted) ...\n`.length : 0;

    if (usedChars + add + headerLen <= budget) {
      chosenRev.push(idx);
      usedChars += add;
    } else {
      break;
    }
  }

  const indices = chosenRev.reverse();
  return {
    indices,
    text: renderSelectedIndices(lines, indices, leadingOmission),
  };
}

function compactSingleOversizedErrorLine(
  line: string,
  lineIdx: number,
  limit: number,
): string {
  const rawPrefix = lineIdx > 0 ? `... (${lineIdx} lines omitted) ...\n` : "";
  const prefix = limit - rawPrefix.length >= 40 ? rawPrefix : "";
  const avail = limit - prefix.length;
  if (line.length <= avail) {
    return `${prefix}${line}`;
  }
  const joiner = " ... ";
  if (avail <= joiner.length + 2) {
    return `${prefix}${sliceTailSafeChars(line, avail)}`;
  }
  const contentAvail = avail - joiner.length;
  const headChars = Math.max(1, Math.floor(contentAvail * 0.28));
  const tailChars = Math.max(1, contentAvail - headChars);
  return `${prefix}${sliceSafeChars(line, headChars)}${joiner}${sliceTailSafeChars(line, tailChars)}`;
}

function compactLongFailureLines(lines: string[], maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";

  const fullText = lines.join("\n");
  if (fullText.length <= limit) return fullText;

  // Tiny budget fallback: preserve the end of the failure output (surrogate-safe)
  if (limit < 80) {
    if (limit <= 3) return sliceTailSafeChars(fullText, limit);
    return `...${sliceTailSafeChars(fullText, limit - 3)}`;
  }

  // Locate first root-cause / real error line and build error+tail candidate set
  let firstErrorLineIdx = -1;
  const keepIndices = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (ROOT_CAUSE_HEADER_PATTERN.test(line)) {
      if (firstErrorLineIdx === -1) firstErrorLineIdx = i;
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 8);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    } else if (isErrorLine(line)) {
      if (firstErrorLineIdx === -1) firstErrorLineIdx = i;
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 3);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    }
  }

  // Always include the final 15 lines for summary/stack tail
  const tailStart = Math.max(0, lines.length - PROTECTED_TAIL_LINES);
  for (let i = tailStart; i < lines.length; i++) {
    keepIndices.add(i);
  }

  // No real error markers found: fill backward from the very end across all lines
  if (firstErrorLineIdx === -1) {
    const allIndices = Array.from({ length: lines.length }, (_, idx) => idx);
    const tailPacked = packTailIndices(lines, allIndices, limit, true);
    if (tailPacked.text) return tailPacked.text;
    return `...${sliceTailSafeChars(lines[lines.length - 1]!, limit - 3)}`;
  }

  const candidateIndices = [...keepIndices].sort((a, b) => a - b);
  const fullCandidatesText = renderSelectedIndices(lines, candidateIndices, true);
  if (fullCandidatesText.length <= limit) {
    return fullCandidatesText;
  }

  // Check if tail-priority packing alone already preserves the first real error
  const tailOnly = packTailIndices(lines, candidateIndices, limit, true);
  if (tailOnly.indices.length > 0 && tailOnly.indices[0]! <= firstErrorLineIdx) {
    return tailOnly.text;
  }

  // Single-line / last-line oversized error: allocate full limit across ~28% head + ~72% tail
  if (firstErrorLineIdx === candidateIndices[candidateIndices.length - 1]!) {
    return compactSingleOversizedErrorLine(lines[firstErrorLineIdx]!, firstErrorLineIdx, limit);
  }

  // Early error exists distinct from the tail:
  // Allocate ~28% to the first root-cause/error cluster and ~72% (+ unused head) to tail.
  const maxSepLen = `\n... (${lines.length} lines omitted) ...\n`.length;
  const usableForSplit = Math.max(0, limit - maxSepLen);
  const headBudget = Math.floor(usableForSplit * 0.28);

  const firstPosInCandidates = candidateIndices.indexOf(firstErrorLineIdx);
  const headIndices: number[] = [];

  if (headBudget >= 24 && firstPosInCandidates !== -1) {
    // Optionally include 1 line of context before firstErrorLineIdx if compact
    const prevIdx = firstErrorLineIdx - 1;
    const leadIfPrev = prevIdx > 0 ? `... (${prevIdx} lines omitted) ...\n`.length : 0;
    const prevLine = prevIdx >= 0 ? lines[prevIdx]! : "";
    const firstLine = lines[firstErrorLineIdx]!;
    if (
      prevIdx >= 0 &&
      prevLine.length <= Math.floor(headBudget * 0.35) &&
      leadIfPrev + prevLine.length + 1 + firstLine.length <= headBudget
    ) {
      headIndices.push(prevIdx);
    }

    for (let pos = firstPosInCandidates; pos < candidateIndices.length; pos++) {
      const idx = candidateIndices[pos]!;
      // Keep head focused on the first contiguous error cluster once first error is in
      if (headIndices.length > 0 && idx > headIndices[headIndices.length - 1]! + 1) {
        break;
      }
      const trial = [...headIndices, idx];
      const rendered = renderSelectedIndices(lines, trial, true);
      if (rendered.length <= headBudget) {
        headIndices.push(idx);
      } else {
        break;
      }
    }
  }

  let headText = "";
  let headLastIdx = -1;
  if (headIndices.length > 0) {
    headText = renderSelectedIndices(lines, headIndices, true);
    headLastIdx = headIndices[headIndices.length - 1]!;
  } else if (headBudget >= 12) {
    // First error line alone exceeded headBudget: preserve its prefix safely
    const leadPrefix =
      firstErrorLineIdx > 0 ? `... (${firstErrorLineIdx} lines omitted) ...\n` : "";
    const avail = headBudget - leadPrefix.length;
    if (avail > 6) {
      headText = `${leadPrefix}${sliceSafeChars(lines[firstErrorLineIdx]!, avail - 3)}...`;
    } else {
      headText = `${sliceSafeChars(lines[firstErrorLineIdx]!, Math.max(0, headBudget - 3))}...`;
    }
    headLastIdx = firstErrorLineIdx;
  }

  if (!headText) {
    if (tailOnly.text) return tailOnly.text;
    return `...${sliceTailSafeChars(lines[lines.length - 1]!, limit - 3)}`;
  }

  const remainingCandidates = candidateIndices.filter((idx) => idx > headLastIdx);
  const tailBudget = Math.max(0, limit - headText.length - maxSepLen);
  const tailPacked = packTailIndices(lines, remainingCandidates, tailBudget, false);

  if (tailPacked.indices.length > 0) {
    const omitted = tailPacked.indices[0]! - headLastIdx - 1;
    const sep = omitted > 0 ? `\n... (${omitted} lines omitted) ...\n` : "\n";
    const combinedResult = `${headText}${sep}${tailPacked.text}`;
    return combinedResult.length <= limit
      ? combinedResult
      : sliceSafeChars(combinedResult, limit);
  }

  if (remainingCandidates.length > 0 && tailBudget > 6) {
    const lastIdx = remainingCandidates[remainingCandidates.length - 1]!;
    const omitted = lastIdx - headLastIdx - 1;
    const sep = omitted > 0 ? `\n... (${omitted} lines omitted) ...\n` : "\n";
    const availTail = limit - headText.length - sep.length;
    if (availTail > 3) {
      const tailSlice = `...${sliceTailSafeChars(lines[lastIdx]!, availTail - 3)}`;
      const combinedResult = `${headText}${sep}${tailSlice}`;
      return combinedResult.length <= limit
        ? combinedResult
        : sliceSafeChars(combinedResult, limit);
    }
  }

  return headText.length <= limit ? headText : sliceSafeChars(headText, limit);
}

export interface FormatCompactCommandOutputParams {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  maxChars: number;
}

export interface CompactCommandOutputMeta {
  text: string;
  collapsedLines: number;
  truncated: boolean;
  rawLines: number;
  rawChars: number;
}

export function formatCompactCommandOutputWithMeta(
  params: FormatCompactCommandOutputParams,
): CompactCommandOutputMeta {
  const out = normalizeTerminalOutput(params.stdout);
  const err = normalizeTerminalOutput(params.stderr);
  const combined = [out, err].filter(Boolean).join("\n");
  const rawChars = combined.length;
  const rawLines = combined ? combined.split("\n").length : 0;

  if (params.error) {
    const full = `spawn error: ${params.error}`;
    const text = truncateWithNotice(full, params.maxChars);
    return {
      text,
      collapsedLines: 0,
      truncated: text !== full,
      rawLines,
      rawChars,
    };
  }

  if (params.timedOut) {
    const tail = getTailLines(combined, 20);
    const body = tail ? `TIMED OUT\n${tail}` : "TIMED OUT (no output)";
    const text = truncateWithNotice(body, params.maxChars);
    return {
      text,
      collapsedLines: 0,
      truncated: text !== body || rawLines > 20,
      rawLines,
      rawChars,
    };
  }

  if (params.exitCode === 0) {
    if (!combined) {
      return {
        text: "OK",
        collapsedLines: 0,
        truncated: false,
        rawLines: 0,
        rawChars: 0,
      };
    }
    const lines = combined
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // Keep at most 2 concise summary lines on success
    const summaryLines = lines.filter((l) => SUMMARY_LINE_PATTERN.test(l));
    const picked =
      summaryLines.length > 0
        ? summaryLines.slice(-2)
        : lines.length <= 2
          ? lines
          : [lines[lines.length - 1]!];
    const joined = picked.join(" | ");
    const cap = Math.min(params.maxChars, 320);
    const text = truncateWithNotice(joined, cap);
    return {
      text,
      collapsedLines: 0,
      truncated: text !== joined,
      rawLines,
      rawChars,
    };
  }

  // Non-zero exit: drop noisy info JSON / Maven boilerplate lines first
  if (!combined) {
    const fallback = `Exited with code ${params.exitCode ?? "unknown"}`;
    const text = truncateWithNotice(fallback, params.maxChars);
    return {
      text,
      collapsedLines: 0,
      truncated: text !== fallback,
      rawLines: 0,
      rawChars: 0,
    };
  }

  const splitLines = combined.split("\n");
  const filteredLines = splitLines.filter((line) => !isFailureNoiseLine(line));
  const cleanedLines = filteredLines.length > 0 ? filteredLines : splitLines;

  // Proactive conservative-whitelist folding of green build/pass runs (even when <= maxChars)
  const { lines: foldedLines, collapsedLines } = foldGreenBuildPhaseLines(cleanedLines);
  const foldedCombined = foldedLines.join("\n");

  if (foldedCombined.length <= params.maxChars) {
    return {
      text: foldedCombined,
      collapsedLines,
      truncated: false,
      rawLines,
      rawChars,
    };
  }

  const text = compactLongFailureLines(foldedLines, params.maxChars);
  return {
    text,
    collapsedLines,
    truncated: true,
    rawLines,
    rawChars,
  };
}

export function formatCompactCommandOutput(
  params: FormatCompactCommandOutputParams,
): string {
  return formatCompactCommandOutputWithMeta(params).text;
}

function getTailLines(text: string, count: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.slice(-count).join("\n");
}
