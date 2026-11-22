import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  formatCorruptedArrayError,
  isPlainObject,
  parseMaybeJsonArray,
  type CorruptedItem,
} from "../utils/arg-validation.js";
import { MCP_CALL_BUDGET_SEC, runShellCommandAsync, type ExecResult } from "../utils/exec-utils.js";
import { resolvePath } from "../utils/fs-utils.js";
import {
  DEFAULT_INLINE_MAX_BYTES,
  computeWaterFillBudgets,
  fitSectionsToBudget,
  fitSectionsToByteBudget,
  formatCompactCommandOutputWithMeta,
  normalizeTerminalOutput,
  sliceSafeChars,
  sliceUtf8Bytes,
  truncateWithByteNotice,
  truncateWithNotice,
  type CompactCommandOutputMeta,
} from "../utils/output-filter.js";
import {
  formatSpillFooter,
  writeSpillFile,
  type SpillSectionInput,
} from "../utils/spill.js";

export interface CheckCommandSpec {
  name?: string;
  command: string;
  cwd?: string;
  timeoutSec?: number;
}

export interface RunChecksInput {
  cwd?: string;
  commands: Array<string | CheckCommandSpec>;
  concurrency?: number;
  timeoutSec?: number;
  outputMode?: "compact" | "full";
  maxChars?: number;
}

interface NormalizedCommand {
  index: number;
  name: string;
  command: string;
  cwd: string;
  timeoutMs: number;
}

interface CheckRunOutcome {
  spec: NormalizedCommand;
  /** null when the call budget ran out before the command could start. */
  result: ExecResult | null;
  passed: boolean;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export async function runChecks(
  input: RunChecksInput,
  budgetMs = MCP_CALL_BUDGET_SEC * 1000,
): Promise<{ text: string; isError: boolean }> {
  const parsedCommands = parseMaybeJsonArray(input?.commands);
  if (!parsedCommands.ok) {
    if (
      parsedCommands.kind === "corrupted_literal" ||
      (parsedCommands.kind === "wrong_type" &&
        (typeof input?.commands === "boolean" || input?.commands === null))
    ) {
      return {
        text: formatCorruptedArrayError({
          header: "Validation failed",
          toolName: "run_checks",
          items: [
            {
              label: "commands",
              value:
                parsedCommands.kind === "corrupted_literal" ? parsedCommands.value : input.commands,
              expected: "an array of command specs",
            },
          ],
          fallbackAdvice: "immediately fall back to a single compound run_command call.",
        }),
        isError: true,
      };
    }
    return {
      text: "Error: 'commands' must be a non-empty array of check commands.",
      isError: true,
    };
  }
  const rawCommands = parsedCommands.value;
  if (rawCommands.length === 0) {
    return {
      text: "Error: 'commands' must be a non-empty array of check commands.",
      isError: true,
    };
  }
  if (rawCommands.length > 12) {
    return {
      text: "Error: 'commands' supports at most 12 commands per call.",
      isError: true,
    };
  }

  const corruptedCommands: CorruptedItem[] = [];
  for (let i = 0; i < rawCommands.length; i++) {
    const raw = rawCommands[i];
    if (typeof raw !== "string" && !isPlainObject(raw)) {
      corruptedCommands.push({
        label: `commands[${i}]`,
        value: raw,
        expected: "a command string or object ({ name?, command, cwd?, timeoutSec? })",
      });
    }
  }
  if (corruptedCommands.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "run_checks",
        items: corruptedCommands,
        fallbackAdvice: "immediately fall back to a single compound run_command call.",
      }),
      isError: true,
    };
  }

  const baseCwd = resolvePath(input.cwd || process.cwd());
  try {
    const st = await fs.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }

  const concurrency = clampInt(input.concurrency, 1, 8, 4);
  const defaultTimeoutSec = clampInt(input.timeoutSec, 1, MCP_CALL_BUDGET_SEC, 60);
  const outputMode = input.outputMode === "full" ? "full" : "compact";
  const maxChars = clampInt(input.maxChars, 500, DEFAULT_INLINE_MAX_BYTES, 8_000);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;

  const normalized: NormalizedCommand[] = [];
  for (let i = 0; i < rawCommands.length; i++) {
    const raw = rawCommands[i];
    const spec: CheckCommandSpec =
      typeof raw === "string" ? { command: raw } : (raw as unknown as CheckCommandSpec);
    if (!spec || typeof spec.command !== "string" || !spec.command.trim()) {
      return {
        text: `Error: commands[${i}] must contain a non-empty 'command' string.`,
        isError: true,
      };
    }
    if (spec.cwd !== undefined && spec.cwd !== null && typeof spec.cwd !== "string") {
      return {
        text: `Error: commands[${i}].cwd must be a string path.`,
        isError: true,
      };
    }
    const trimmedSpecCwd = spec.cwd?.trim() || "";
    const cmdCwd = trimmedSpecCwd ? resolvePath(trimmedSpecCwd, baseCwd) : baseCwd;
    if (trimmedSpecCwd) {
      try {
        const st = await fs.stat(cmdCwd);
        if (!st.isDirectory()) {
          return {
            text: `Error: commands[${i}].cwd is not a directory: ${cmdCwd}`,
            isError: true,
          };
        }
      } catch {
        return {
          text: `Error: commands[${i}].cwd does not exist: ${cmdCwd}`,
          isError: true,
        };
      }
    }
    const cmdTimeoutSec = clampInt(
      spec.timeoutSec,
      1,
      MCP_CALL_BUDGET_SEC,
      defaultTimeoutSec,
    );
    normalized.push({
      index: i,
      name: spec.name?.trim() || `check-${i + 1}`,
      command: spec.command.trim(),
      cwd: cmdCwd,
      timeoutMs: cmdTimeoutSec * 1000,
    });
  }

  const safeBudgetMs =
    Number.isFinite(budgetMs) && budgetMs > 0
      ? Math.max(100, Math.trunc(budgetMs))
      : MCP_CALL_BUDGET_SEC * 1000;
  const wallStart = performance.now();
  const deadline = wallStart + safeBudgetMs;
  const outcomes = await mapWithConcurrency<NormalizedCommand, CheckRunOutcome>(
    normalized,
    concurrency,
    async (spec) => {
      const remainingMs = deadline - performance.now();
      // exec-utils clamps timeouts to >=100ms plus kill grace; avoid starting doomed commands
      if (remainingMs < 100) return { spec, result: null, passed: false };
      const result = await runShellCommandAsync(spec.command, {
        cwd: spec.cwd,
        timeoutMs: Math.min(spec.timeoutMs, remainingMs),
      });
      const passed = !result.error && !result.timedOut && result.exitCode === 0;
      return { spec, result, passed };
    },
  );
  const wallMs = Math.round(performance.now() - wallStart);

  const passedCount = outcomes.filter((o) => o.passed).length;
  const notRunCount = outcomes.filter((o) => !o.result).length;
  const failedCount = outcomes.length - passedCount - notRunCount;

  const counts = [`${passedCount}/${outcomes.length} passed`];
  if (failedCount > 0) counts.push(`${failedCount} failed`);
  if (notRunCount > 0) {
    counts.push(
      `${notRunCount} not run (call time budget of ${Math.round(safeBudgetMs / 1000)}s used up; run them in another call)`,
    );
  }
  const summaryHeader = `Checks: ${counts.join(", ")} (wall: ${wallMs}ms)`;
  const separator = "\n\n";
  const bodyBudget = Math.max(0, maxChars - summaryHeader.length - separator.length);
  const bodyByteBudget = Math.max(
    0,
    maxBytes - Buffer.byteLength(summaryHeader, "utf8") - Buffer.byteLength(separator, "utf8"),
  );

  const firstPass = renderRunChecksBody(
    outcomes,
    outputMode,
    bodyBudget,
    bodyByteBudget,
    separator,
  );

  if (firstPass.spillTriggered) {
    const minBodyChars = Math.max(200, outcomes.length * 52);
    const minBodyBytes = minBodyChars;
    const footerCapChars = Math.min(480, bodyBudget - minBodyChars);
    const footerCapBytes = Math.min(900, bodyByteBudget - minBodyBytes);

    if (footerCapChars >= 48 && footerCapBytes >= 48) {
      const spillSections: SpillSectionInput[] = [];
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i]!;
        if (!outcome.result) continue;
        spillSections.push({
          label: outcome.spec.name,
          content: buildNormalizedCommandOutput(outcome.result),
          truncated: firstPass.truncatedOutcomeIndices.has(i),
        });
      }

      if (spillSections.length > 0) {
        const spillResult = await writeSpillFile({
          tool: "run_checks",
          sections: spillSections,
        });
        if (spillResult) {
          const footer = formatSpillFooter(spillResult, {
            maxChars: footerCapChars,
            maxBytes: footerCapBytes,
          });
          if (!footer) {
            await fs.unlink(spillResult.filePath).catch(() => {});
          } else {
            const footerBytes = Buffer.byteLength(footer, "utf8");
            const reducedBodyBudget = Math.max(0, bodyBudget - footer.length);
            const reducedBodyByteBudget = Math.max(0, bodyByteBudget - footerBytes);
            const secondPass = renderRunChecksBody(
              outcomes,
              outputMode,
              reducedBodyBudget,
              reducedBodyByteBudget,
              separator,
            );
            const maxPrefixChars = Math.max(0, maxChars - footer.length);
            const maxPrefixBytes = Math.max(0, maxBytes - footerBytes);
            let prefix = truncateWithNotice(
              `${summaryHeader}${separator}${secondPass.fittedBody}`,
              maxPrefixChars,
            );
            prefix = truncateWithByteNotice(prefix, maxPrefixBytes);
            return { text: `${prefix}${footer}`, isError: false };
          }
        }
      }
    }
  }

  let text = truncateWithNotice(
    `${summaryHeader}${separator}${firstPass.fittedBody}`,
    maxChars,
  );
  text = truncateWithByteNotice(text, maxBytes);
  return { text, isError: false };
}

function buildNormalizedCommandOutput(result: ExecResult): string {
  const combined = [
    normalizeTerminalOutput(result.stdout),
    normalizeTerminalOutput(result.stderr),
  ]
    .filter(Boolean)
    .join("\n");
  return result.error ? `spawn error: ${result.error}` : combined || "(no output)";
}

function detectFittedTruncation(
  blocks: string[],
  bodyBudget: number,
  bodyByteBudget: number,
  separator: string,
): Set<number> {
  const truncated = new Set<number>();
  if (blocks.length === 0) return truncated;
  const joined = blocks.join(separator);
  const sepChars = separator.length * (blocks.length - 1);
  const sepBytes = Buffer.byteLength(separator, "utf8") * (blocks.length - 1);

  if (joined.length > bodyBudget) {
    if (sepChars >= bodyBudget) {
      for (let i = 0; i < blocks.length; i++) truncated.add(i);
    } else {
      const charBudgets = computeWaterFillBudgets(
        blocks.map((b) => b.length),
        bodyBudget - sepChars,
      );
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i]!.length > (charBudgets[i] ?? 0)) {
          truncated.add(i);
        }
      }
    }
  }

  const charFitted = fitSectionsToBudget(blocks, bodyBudget, separator);
  if (Buffer.byteLength(charFitted, "utf8") > bodyByteBudget) {
    if (sepBytes >= bodyByteBudget) {
      for (let i = 0; i < blocks.length; i++) truncated.add(i);
    } else {
      const byteBudgets = computeWaterFillBudgets(
        blocks.map((b) => Buffer.byteLength(b, "utf8")),
        bodyByteBudget - sepBytes,
      );
      for (let i = 0; i < blocks.length; i++) {
        if (Buffer.byteLength(blocks[i]!, "utf8") > (byteBudgets[i] ?? 0)) {
          truncated.add(i);
        }
      }
    }
  }

  return truncated;
}

function renderRunChecksBody(
  outcomes: CheckRunOutcome[],
  outputMode: "compact" | "full",
  bodyBudget: number,
  bodyByteBudget: number,
  separator: string,
): {
  fittedBody: string;
  spillTriggered: boolean;
  truncatedOutcomeIndices: Set<number>;
} {
  const truncatedOutcomeIndices = new Set<number>();
  let spillTriggered = false;
  let blocks: string[];

  if (outputMode === "full") {
    blocks = outcomes.map(({ spec, result, passed }) => {
      if (!result) return `## [NOT RUN] ${spec.name}\n$ ${spec.command}`;
      const badge = result.error
        ? "ERROR"
        : result.timedOut
          ? "TIMEOUT"
          : passed
            ? "PASS"
            : `FAIL (exit ${result.exitCode ?? "err"})`;
      const body = buildNormalizedCommandOutput(result);
      return `## [${badge}] ${spec.name} (${result.durationMs}ms)\n$ ${spec.command}\n${body}`;
    });
  } else {
    // Tiered budget pool + 2-pass water-filling:
    // Fixed tier: PASS (concise 1-line summary <= 300 chars; yields budget if starving FAIL) + [NOT RUN]
    // Elastic tier: FAIL / ERROR / TIMEOUT commands water-fill the remaining char & UTF-8 byte budget
    blocks = new Array<string>(outcomes.length);
    interface PassEntry {
      index: number;
      compactHeader: string;
      body: string;
      fullBlock: string;
    }
    interface FailEntry {
      index: number;
      spec: NormalizedCommand;
      result: ExecResult;
      badgeLine: string;
      header: string;
      pass1Meta: CompactCommandOutputMeta;
      pass1Body: string;
      pass1Block: string;
    }
    const passEntries: PassEntry[] = [];
    const failEntries: FailEntry[] = [];
    let notRunChars = 0;
    let notRunBytes = 0;
    let passChars = 0;
    let passBytes = 0;

    for (let i = 0; i < outcomes.length; i++) {
      const { spec, result, passed } = outcomes[i]!;
      if (!result) {
        const block = `## [NOT RUN] ${spec.name}\n$ ${spec.command}`;
        blocks[i] = block;
        notRunChars += block.length;
        notRunBytes += Buffer.byteLength(block, "utf8");
        continue;
      }

      if (passed) {
        const body = formatCompactCommandOutputWithMeta({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          error: result.error,
          maxChars: 300,
        }).text;
        const compactHeader = `- [PASS ${result.durationMs}ms] ${spec.name}`;
        const fullBlock = `${compactHeader} (\`${spec.command}\`): ${body}`;
        blocks[i] = fullBlock;
        passChars += fullBlock.length;
        passBytes += Buffer.byteLength(fullBlock, "utf8");
        passEntries.push({ index: i, compactHeader, body, fullBlock });
        continue;
      }

      const badge = result.error
        ? "ERROR"
        : result.timedOut
          ? "TIMEOUT"
          : `FAIL (exit ${result.exitCode ?? "err"})`;
      const badgeLine = `## [${badge} ${result.durationMs}ms] ${spec.name}\n`;
      const header = `${badgeLine}$ ${spec.command}\n`;

      // Pass 1: fold & clean without premature per-command truncation to measure true folded size
      const pass1Ceiling = Math.max(
        bodyBudget,
        result.stdout.length + result.stderr.length + 256,
      );
      const pass1Meta = formatCompactCommandOutputWithMeta({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        error: result.error,
        maxChars: pass1Ceiling,
      });
      failEntries.push({
        index: i,
        spec,
        result,
        badgeLine,
        header,
        pass1Meta,
        pass1Body: pass1Meta.text,
        pass1Block: `${header}${pass1Meta.text}`,
      });
    }

    if (failEntries.length > 0) {
      const totalSepChars = separator.length * Math.max(0, outcomes.length - 1);
      const totalSepBytes =
        Buffer.byteLength(separator, "utf8") * Math.max(0, outcomes.length - 1);
      const availChars = Math.max(0, bodyBudget - totalSepChars);
      const availBytes = Math.max(0, bodyByteBudget - totalSepBytes);
      const availAfterNotRunChars = Math.max(0, availChars - notRunChars);
      const availAfterNotRunBytes = Math.max(0, availBytes - notRunBytes);

      const rawFailPoolChars = Math.max(0, availAfterNotRunChars - passChars);
      const rawFailPoolBytes = Math.max(0, availAfterNotRunBytes - passBytes);

      // When verbose PASS summaries would starve FAIL output, shrink PASS summaries first
      // so FAIL blocks keep at least their header + error body (up to 60% of available pool).
      if (passEntries.length > 0) {
        const minPassReserveChars = passEntries.reduce(
          (sum, p) => sum + Math.min(p.fullBlock.length, p.compactHeader.length),
          0,
        );
        const minPassReserveBytes = passEntries.reduce(
          (sum, p) =>
            sum +
            Math.min(
              Buffer.byteLength(p.fullBlock, "utf8"),
              Buffer.byteLength(p.compactHeader, "utf8"),
            ),
          0,
        );
        const totalFailDemandChars = failEntries.reduce(
          (sum, f) => sum + f.pass1Block.length,
          0,
        );
        const totalFailDemandBytes = failEntries.reduce(
          (sum, f) => sum + Buffer.byteLength(f.pass1Block, "utf8"),
          0,
        );
        const failFloorChars = Math.max(
          failEntries.reduce(
            (sum, f) => sum + f.header.length + Math.min(f.pass1Body.length, 160),
            0,
          ),
          Math.floor(availAfterNotRunChars * 0.6),
        );
        const failFloorBytes = Math.max(
          failEntries.reduce(
            (sum, f) =>
              sum +
              Buffer.byteLength(f.header, "utf8") +
              Math.min(Buffer.byteLength(f.pass1Body, "utf8"), 160),
            0,
          ),
          Math.floor(availAfterNotRunBytes * 0.6),
        );
        const desiredFailChars = Math.min(
          totalFailDemandChars,
          Math.max(0, availAfterNotRunChars - minPassReserveChars),
          failFloorChars,
        );
        const desiredFailBytes = Math.min(
          totalFailDemandBytes,
          Math.max(0, availAfterNotRunBytes - minPassReserveBytes),
          failFloorBytes,
        );

        if (rawFailPoolChars < desiredFailChars || rawFailPoolBytes < desiredFailBytes) {
          const passPoolChars = Math.max(
            0,
            availAfterNotRunChars - Math.max(rawFailPoolChars, desiredFailChars),
          );
          const passPoolBytes = Math.max(
            0,
            availAfterNotRunBytes - Math.max(rawFailPoolBytes, desiredFailBytes),
          );
          const passCharShares = computeWaterFillBudgets(
            passEntries.map((p) => p.fullBlock.length),
            passPoolChars,
          );
          const passByteShares = computeWaterFillBudgets(
            passEntries.map((p) => Buffer.byteLength(p.fullBlock, "utf8")),
            passPoolBytes,
          );

          passChars = 0;
          passBytes = 0;
          for (let pIdx = 0; pIdx < passEntries.length; pIdx++) {
            const p = passEntries[pIdx]!;
            const shareChars = passCharShares[pIdx] ?? 0;
            const shareBytes = passByteShares[pIdx] ?? 0;
            let shrunk = p.fullBlock;
            if (
              shrunk.length > shareChars ||
              Buffer.byteLength(shrunk, "utf8") > shareBytes
            ) {
              const noCmd = `${p.compactHeader}: ${p.body}`;
              if (
                noCmd.length <= shareChars &&
                Buffer.byteLength(noCmd, "utf8") <= shareBytes
              ) {
                shrunk = noCmd;
              } else {
                const hdrBytes = Buffer.byteLength(p.compactHeader, "utf8");
                const bodyCharsAvail = shareChars - p.compactHeader.length - 2;
                const bodyBytesAvail = shareBytes - hdrBytes - 2;
                if (bodyCharsAvail >= 8 && bodyBytesAvail >= 8) {
                  const trimmedBody = sliceUtf8Bytes(
                    sliceSafeChars(p.body, bodyCharsAvail - 3),
                    bodyBytesAvail - 3,
                  );
                  shrunk = `${p.compactHeader}: ${trimmedBody}...`;
                } else if (
                  p.compactHeader.length <= shareChars &&
                  hdrBytes <= shareBytes
                ) {
                  shrunk = p.compactHeader;
                } else {
                  shrunk = sliceUtf8Bytes(
                    sliceSafeChars(p.compactHeader, shareChars),
                    shareBytes,
                  );
                }
                truncatedOutcomeIndices.add(p.index);
                spillTriggered = true;
              }
            }
            blocks[p.index] = shrunk;
            passChars += shrunk.length;
            passBytes += Buffer.byteLength(shrunk, "utf8");
          }
        }
      }

      // Strictly cap FAIL pools at available budget minus separators and fixed blocks
      const failPoolChars = Math.max(0, availAfterNotRunChars - passChars);
      const failPoolBytes = Math.max(0, availAfterNotRunBytes - passBytes);

      // Pass 2: water-fill char and UTF-8 byte budgets across FAIL commands
      const charBlockBudgets = computeWaterFillBudgets(
        failEntries.map((entry) => entry.pass1Block.length),
        failPoolChars,
      );
      const byteBlockBudgets = computeWaterFillBudgets(
        failEntries.map((entry) => Buffer.byteLength(entry.pass1Block, "utf8")),
        failPoolBytes,
      );

      for (let j = 0; j < failEntries.length; j++) {
        const entry = failEntries[j]!;
        const blockCharBudget = charBlockBudgets[j] ?? 0;
        const blockByteBudget = byteBlockBudgets[j] ?? 0;
        const pass1BodyBytes = Buffer.byteLength(entry.pass1Body, "utf8");
        const fullHeaderBytes = Buffer.byteLength(entry.header, "utf8");

        // Keep full header unless the command string itself would starve the error body
        let effectiveHeader = entry.header;
        if (
          entry.header.length + Math.min(entry.pass1Body.length, 60) > blockCharBudget ||
          fullHeaderBytes + Math.min(pass1BodyBytes, 60) > blockByteBudget
        ) {
          const badgeBytes = Buffer.byteLength(entry.badgeLine, "utf8");
          const remChars = blockCharBudget - entry.badgeLine.length;
          const remBytes = blockByteBudget - badgeBytes;
          if (remChars >= 64 && remBytes >= 64) {
            const cmdCap = Math.max(8, Math.floor(Math.min(remChars, remBytes) * 0.35) - 6);
            const rawCmdBytes = Buffer.byteLength(entry.spec.command, "utf8");
            const shortCmd =
              entry.spec.command.length <= cmdCap && rawCmdBytes <= cmdCap
                ? entry.spec.command
                : `${sliceUtf8Bytes(sliceSafeChars(entry.spec.command, cmdCap), cmdCap)}...`;
            effectiveHeader = `${entry.badgeLine}$ ${shortCmd}\n`;
          } else {
            effectiveHeader = entry.badgeLine;
          }
        }

        const headerChars = effectiveHeader.length;
        const headerBytes = Buffer.byteLength(effectiveHeader, "utf8");
        const allowedBodyChars = Math.max(0, blockCharBudget - headerChars);
        const allowedBodyBytes = Math.max(0, blockByteBudget - headerBytes);

        let finalMeta: CompactCommandOutputMeta;
        let failHardTruncated = false;

        if (
          entry.pass1Body.length <= allowedBodyChars &&
          pass1BodyBytes <= allowedBodyBytes
        ) {
          finalMeta = entry.pass1Meta;
          blocks[entry.index] = `${effectiveHeader}${entry.pass1Body}`;
        } else {
          failHardTruncated = true;
          const bytesPerChar = pass1BodyBytes / Math.max(1, entry.pass1Body.length);
          let targetChars = Math.min(
            allowedBodyChars,
            Math.floor(allowedBodyBytes / Math.max(1, bytesPerChar)),
          );
          finalMeta =
            targetChars > 0
              ? formatCompactCommandOutputWithMeta({
                  stdout: entry.result.stdout,
                  stderr: entry.result.stderr,
                  exitCode: entry.result.exitCode,
                  timedOut: entry.result.timedOut,
                  error: entry.result.error,
                  maxChars: targetChars,
                })
              : {
                  text: "",
                  collapsedLines: entry.pass1Meta.collapsedLines,
                  truncated: true,
                  rawLines: entry.pass1Meta.rawLines,
                  rawChars: entry.pass1Meta.rawChars,
                };

          // Converge char cap when multi-byte density in preserved head/tail exceeds average
          for (let iter = 0; iter < 4 && targetChars > 1; iter++) {
            const curBytes = Buffer.byteLength(finalMeta.text, "utf8");
            if (curBytes <= allowedBodyBytes) break;
            targetChars = Math.max(
              1,
              Math.min(
                targetChars - 1,
                Math.floor(targetChars * (allowedBodyBytes / curBytes) * 0.98),
              ),
            );
            finalMeta = formatCompactCommandOutputWithMeta({
              stdout: entry.result.stdout,
              stderr: entry.result.stderr,
              exitCode: entry.result.exitCode,
              timedOut: entry.result.timedOut,
              error: entry.result.error,
              maxChars: targetChars,
            });
          }

          blocks[entry.index] = `${effectiveHeader}${finalMeta.text}`;
        }

        const otherFailChars = failEntries.reduce(
          (sum, f, idx) => (idx === j ? sum : sum + f.pass1Block.length),
          0,
        );
        const availableBodyCeiling = Math.max(
          allowedBodyChars,
          failPoolChars - otherFailChars - headerChars,
          Math.floor(failPoolChars / failEntries.length) - headerChars,
        );

        if (
          failHardTruncated ||
          finalMeta.truncated ||
          finalMeta.collapsedLines >= 20 ||
          finalMeta.rawChars > availableBodyCeiling
        ) {
          spillTriggered = true;
          truncatedOutcomeIndices.add(entry.index);
        }
      }
    }
  }

  const fitTruncated = detectFittedTruncation(
    blocks,
    bodyBudget,
    bodyByteBudget,
    separator,
  );
  if (fitTruncated.size > 0) {
    for (const idx of fitTruncated) {
      if (outcomes[idx]?.result) {
        truncatedOutcomeIndices.add(idx);
        spillTriggered = true;
      }
    }
  }

  const fittedBody = fitSectionsToByteBudget(
    blocks,
    bodyBudget,
    bodyByteBudget,
    separator,
  );
  return { fittedBody, spillTriggered, truncatedOutcomeIndices };
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== "number" && typeof val !== "string") return fallback;
  if (typeof val === "string" && val.trim() === "") return fallback;
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}
