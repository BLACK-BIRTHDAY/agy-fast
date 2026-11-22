import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeWaterFillBudgets,
  fitSectionsToBudget,
  fitSectionsToByteBudget,
  formatCompactCommandOutput,
  formatCompactCommandOutputWithMeta,
} from "../src/utils/output-filter.js";

describe("output-filter", () => {
  it("computeWaterFillBudgets allocates exact water-filling shares across edge cases", () => {
    assert.deepEqual(computeWaterFillBudgets([], 100), []);
    assert.deepEqual(computeWaterFillBudgets([10, 20], 0), [0, 0]);
    assert.deepEqual(computeWaterFillBudgets([10, 20], -5), [0, 0]);
    assert.deepEqual(computeWaterFillBudgets([10, 20], Number.NaN), [0, 0]);

    // Fits entirely: everyone gets exact requested size
    assert.deepEqual(computeWaterFillBudgets([15, 30, 45], 200), [15, 30, 45]);

    // Empty / tiny items donate 100% of unused share to large items
    assert.deepEqual(
      computeWaterFillBudgets([0, 0, 0, 0, 2000, 2000], 2000),
      [0, 0, 0, 0, 1000, 1000],
    );
    assert.deepEqual(
      computeWaterFillBudgets([10, 500, 10, 500], 420),
      [10, 200, 10, 200],
    );

    // Remainder distributes evenly (max - min <= 1) and never exceeds requested size
    const budgets = computeWaterFillBudgets([10, 20, 30, 100], 77);
    assert.equal(budgets[0], 10);
    assert.equal(budgets[1], 20);
    assert.equal(budgets.reduce((a, b) => a + b, 0), 77);
    assert.ok(budgets[2]! <= 30 && budgets[3]! <= 100);
    assert.ok(Math.abs(budgets[2]! - budgets[3]!) <= 1);

    // Sanitizes negative/NaN item sizes as 0
    assert.deepEqual(
      computeWaterFillBudgets([-5, Number.NaN, 100], 60),
      [0, 0, 60],
    );

    // fitSectionsToBudget & fitSectionsToByteBudget inherit water-filling cleanly
    const fitted = fitSectionsToBudget(["[]", "[]", "A".repeat(400), "B".repeat(400)], 500);
    assert.ok(fitted.length <= 500);
    assert.match(fitted, /A{180,}/);
    assert.match(fitted, /B{180,}/);

    const cjkFitted = fitSectionsToByteBudget(["ok", "中文测试数据".repeat(200)], 2000, 400);
    assert.ok(Buffer.byteLength(cjkFitted, "utf8") <= 400);
    assert.ok(cjkFitted.startsWith("ok\n\n"));
  });

  it("prevents benign zero-error summary lines from false-positive error detection", () => {
    const benignLines = [
      "0 errors",
      "0 failed",
      "errors: 0",
      "failed: 0",
      "0 failures",
      "0 warnings",
      "Found 0 errors.",
      "Tests run: 24, Failures: 0, Errors: 0, Skipped: 0",
      "0 error(s), 0 warning(s)",
    ];
    const log = [
      ...benignLines,
      ...Array.from({ length: 80 }, (_, i) => `neutral log line ${i} ${"x".repeat(40)}`),
      "REAL_ROOT_CAUSE: error TS2322: Type 'string' is not assignable to type 'number'.",
      ...Array.from({ length: 30 }, (_, i) => `aftermath detail ${i} ${"y".repeat(40)}`),
      "FINAL_TAIL_MARKER: Build exited with code 2",
    ].join("\n");

    const res = formatCompactCommandOutputWithMeta({
      stdout: log,
      stderr: "",
      exitCode: 2,
      timedOut: false,
      maxChars: 900,
    });

    assert.equal(res.truncated, true);
    assert.ok(res.text.length <= 900, `Expected <= 900 chars, got ${res.text.length}`);
    // Benign zero-error lines at the top must NOT hijack the first-root-cause slot
    assert.doesNotMatch(res.text, /^0 errors/m);
    assert.doesNotMatch(res.text, /^errors: 0$/m);
    assert.doesNotMatch(res.text, /^failed: 0$/m);
    // Real root cause + final tail must both survive
    assert.match(res.text, /REAL_ROOT_CAUSE: error TS2322/);
    assert.match(res.text, /FINAL_TAIL_MARKER/);

    // Meanwhile real non-zero counts and singular Error: 0 MUST still be recognized
    const realZeroMsg = [
      ...Array.from({ length: 50 }, (_, i) => `step ${i} ${"z".repeat(40)}`),
      "Error: 0 bytes written to socket",
      ...Array.from({ length: 50 }, (_, i) => `trailing ${i} ${"w".repeat(40)}`),
      "END_MARKER",
    ].join("\n");
    const realRes = formatCompactCommandOutput({
      stdout: realZeroMsg,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 650,
    });
    assert.match(realRes, /Error: 0 bytes written to socket/);
    assert.match(realRes, /END_MARKER/);
  });

  it("proactively folds green Vite/monorepo/test/compiler build runs even when <= maxChars", () => {
    const viteAndMonorepoLines = [
      "> @app/shared@1.0.0 build /repo/packages/shared",
      "> vite build",
      "",
      "vite v5.4.1 building for production...",
      "transforming...",
      "✓ 42 modules transformed.",
      "rendering chunks...",
      "computing gzip size...",
      "dist/index.js          12.34 kB │ gzip: 4.12 kB",
      "dist/assets/app.css     3.21 kB │ gzip: 1.05 kB",
      "✓ built in 1.23s",
      "Built dist/cli.mjs (48.2 KB)",
      "Tasks:    3 successful, 3 total",
      // Unknown line must stay verbatim
      "CUSTOM_DIAGNOSTIC_BANNER: schema checksum verified",
      // Test pass + Rust/Go/Gradle/Maven progress run (>= 4 lines)
      "✓ parses manifest (2ms)",
      "✔ loads workspace config (1ms)",
      "PASS test/unit.test.ts",
      "--- PASS: TestRouter (0.00s)",
      "ok\tgithub.com/org/repo/pkg\t0.14s",
      "test auth::verify_token ... ok",
      "Compiling serde v1.0.200",
      "Downloading crates ...",
      "> Task :core:compileKotlin UP-TO-DATE",
      "[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0",
      // Short green run (< 4 lines) must NOT be folded
      "CUSTOM_BOUNDARY_LINE",
      "✓ tiny pass 1",
      "✓ tiny pass 2",
      "✓ tiny pass 3",
      // Final 15+ lines including the real TS failure
      ...Array.from({ length: 12 }, (_, i) => `context line ${i}`),
      "src/app.ts(18,7): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
      "  18 |   greet(42);",
      "     |         ^^",
      "Found 1 error in src/app.ts:18",
    ];
    const combined = viteAndMonorepoLines.join("\n");
    assert.ok(combined.length < 4000, `Fixture should be <= 4000 chars, got ${combined.length}`);

    const meta = formatCompactCommandOutputWithMeta({
      stdout: combined,
      stderr: "",
      exitCode: 2,
      timedOut: false,
      maxChars: 4000,
    });

    assert.equal(meta.truncated, false);
    assert.equal(meta.rawLines, viteAndMonorepoLines.length);
    assert.equal(meta.rawChars, combined.length);
    // Run 1 = 13 lines (indexes 0..12 including bridged blank), Run 2 = 10 lines (indexes 14..23) => 23
    assert.equal(meta.collapsedLines, 23);
    assert.match(
      meta.text,
      /\.\.\. \(collapsed 13 build\/pass lines; last: Tasks:\s+3 successful, 3 total\)/,
    );
    assert.match(
      meta.text,
      /\.\.\. \(collapsed 10 build\/pass lines; last: \[INFO\] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0\)/,
    );
    // Intermediate green lines are gone
    assert.doesNotMatch(meta.text, /rendering chunks/);
    assert.doesNotMatch(meta.text, /Compiling serde/);
    // Unknown lines & short (<4) green run & TS error are preserved verbatim
    assert.match(meta.text, /CUSTOM_DIAGNOSTIC_BANNER: schema checksum verified/);
    assert.match(meta.text, /✓ tiny pass 1\n✓ tiny pass 2\n✓ tiny pass 3/);
    assert.match(meta.text, /error TS2345/);
    assert.equal(
      formatCompactCommandOutput({
        stdout: combined,
        stderr: "",
        exitCode: 2,
        timedOut: false,
        maxChars: 4000,
      }),
      meta.text,
    );
  });

  it("preserves earlier failures and warnings in parallel pnpm -r runs without folding them", () => {
    const lines = [
      "Scope: 4 of 4 workspace projects",
      "packages/pkg-a build$ tsc -b",
      "packages/pkg-a build: src/auth.ts(14,3): error TS2304: Cannot find name 'verifyJwt'.",
      "packages/pkg-a build: Failed",
      // pkg-b succeeds with a long green Vite build
      "packages/pkg-b build$ vite build",
      "packages/pkg-b build: vite v5.4.0 building for production...",
      "packages/pkg-b build: transforming...",
      "packages/pkg-b build: ✓ 28 modules transformed.",
      "packages/pkg-b build: rendering chunks...",
      "packages/pkg-b build: computing gzip size...",
      "packages/pkg-b build: dist/pkg-b.js  24.10 kB │ gzip: 7.40 kB",
      "packages/pkg-b build: ✓ built in 0.92s",
      "packages/pkg-b build: Done",
      "--- maven verification phase ---",
      // Warning line inside Maven [INFO] must NEVER be folded
      "[INFO] Compiling module core",
      "[INFO] Compiling module api",
      "[INFO] Compiling module web",
      "[INFO] 2 warnings detected in deprecated API",
      "[INFO] Packaging jar",
      // Trailing 15 lines
      ...Array.from({ length: 15 }, (_, i) => `packages/pkg-c summary line ${i}`),
    ];

    const meta = formatCompactCommandOutputWithMeta({
      stdout: lines.join("\n"),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 4000,
    });

    assert.equal(meta.truncated, false);
    assert.equal(meta.collapsedLines, 9);
    // Early failure in pkg-a MUST survive verbatim
    assert.match(meta.text, /packages\/pkg-a build: src\/auth\.ts\(14,3\): error TS2304/);
    assert.match(meta.text, /packages\/pkg-a build: Failed/);
    // Green build of pkg-b collapses cleanly
    assert.match(
      meta.text,
      /\.\.\. \(collapsed 9 build\/pass lines; last: packages\/pkg-b build: Done\)/,
    );
    // Warning line was NOT folded
    assert.match(meta.text, /\[INFO\] 2 warnings detected in deprecated API/);
  });

  it("never folds any of the final 15 lines of failure output", () => {
    // Exactly 15 green lines -> 0 collapsed
    const fifteenGreen = Array.from({ length: 15 }, (_, i) => `✓ passing spec ${i + 1}`);
    const res15 = formatCompactCommandOutputWithMeta({
      stdout: fifteenGreen.join("\n"),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 4000,
    });
    assert.equal(res15.collapsedLines, 0);
    assert.equal(res15.text, fifteenGreen.join("\n"));

    // 25 green lines -> only first 10 collapse, final 15 stay verbatim
    const twentyFiveGreen = Array.from({ length: 25 }, (_, i) => `✓ passing spec ${i + 1}`);
    const res25 = formatCompactCommandOutputWithMeta({
      stdout: twentyFiveGreen.join("\n"),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 4000,
    });
    assert.equal(res25.collapsedLines, 10);
    assert.match(
      res25.text,
      /\.\.\. \(collapsed 10 build\/pass lines; last: ✓ passing spec 10\)/,
    );
    for (let i = 11; i <= 25; i++) {
      assert.match(res25.text, new RegExp(`✓ passing spec ${i}(?:\\n|$)`));
    }
  });

  it("uses head-root (~25-30%) + tail-priority (~70-75%) compaction when folded failure > maxChars", () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => `dist/assets/chunk-${i}.js   10.${i} kB │ gzip: 3.1 kB`),
      "src/core.ts(10,1): error TS2304: FIRST_ROOT_CAUSE_MISSING_SYMBOL",
      "  10 | export const broken = FIRST_ROOT_CAUSE_MISSING_SYMBOL;",
      ...Array.from(
        { length: 80 },
        (_, i) => `src/cascade-${i}.ts(${i + 1},5): error TS2322: cascade failure padding ${"x".repeat(35)}`,
      ),
      "src/final.ts(99,9): error TS2345: FINAL_TAIL_FAILURE_MARKER",
      "Found 82 errors in 82 files.",
    ];

    const maxChars = 1000;
    const meta = formatCompactCommandOutputWithMeta({
      stdout: lines.join("\n"),
      stderr: "",
      exitCode: 2,
      timedOut: false,
      maxChars,
    });

    assert.equal(meta.truncated, true);
    assert.equal(meta.collapsedLines, 20);
    assert.ok(meta.text.length <= maxChars, `Expected <= ${maxChars}, got ${meta.text.length}`);
    // Both first root cause AND final tail error/summary survive!
    assert.match(meta.text, /FIRST_ROOT_CAUSE_MISSING_SYMBOL/);
    assert.match(meta.text, /FINAL_TAIL_FAILURE_MARKER/);
    assert.match(meta.text, /Found 82 errors in 82 files\./);
    assert.match(meta.text, /\.\.\. \(\d+ lines omitted\) \.\.\./);

    // Surrogate safety when truncating emoji-rich single-line and multi-line failures
    const emojiLog = [
      `Error: ${"🚀".repeat(200)} FIRST_EMOJI_ERR`,
      ...Array.from({ length: 40 }, (_, i) => `Error: middle ${i} ${"🔥".repeat(40)}`),
      `Error: ${"💥".repeat(120)} TAIL_EMOJI_END`,
    ].join("\n");
    const emojiMeta = formatCompactCommandOutputWithMeta({
      stdout: emojiLog,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 350,
    });
    assert.equal(emojiMeta.truncated, true);
    assert.ok(emojiMeta.text.length <= 350);
    assert.match(emojiMeta.text, /TAIL_EMOJI_END/);
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiMeta.text),
      false,
    );
  });

  it("reports accurate metadata across pass, spawn error, and timeout branches", () => {
    const passMeta = formatCompactCommandOutputWithMeta({
      stdout: "line 1\nAll 42 tests passed\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      maxChars: 500,
    });
    assert.equal(passMeta.text, "All 42 tests passed");
    assert.equal(passMeta.collapsedLines, 0);
    assert.equal(passMeta.truncated, false);
    assert.equal(passMeta.rawLines, 2);
    assert.equal(passMeta.rawChars, "line 1\nAll 42 tests passed".length);

    const errMeta = formatCompactCommandOutputWithMeta({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error: "ENOENT",
      maxChars: 500,
    });
    assert.equal(errMeta.text, "spawn error: ENOENT");
    assert.equal(errMeta.collapsedLines, 0);
    assert.equal(errMeta.truncated, false);

    const timeoutMeta = formatCompactCommandOutputWithMeta({
      stdout: Array.from({ length: 30 }, (_, i) => `tick ${i}`).join("\n"),
      stderr: "",
      exitCode: null,
      timedOut: true,
      maxChars: 500,
    });
    assert.equal(timeoutMeta.collapsedLines, 0);
    assert.equal(timeoutMeta.truncated, true);
    assert.equal(timeoutMeta.rawLines, 30);
    assert.match(timeoutMeta.text, /^TIMED OUT\n/);
    assert.match(timeoutMeta.text, /tick 29/);
  });

  it("handles oversized single-line and last-line errors across full maxChars (~28% head + ~72% tail)", () => {
    const singleLine = `Error: ${"a".repeat(450)} REAL_CAUSE_AT_END`;
    const resSingle = formatCompactCommandOutputWithMeta({
      stdout: singleLine,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 300,
    });
    assert.equal(resSingle.truncated, true);
    assert.ok(resSingle.text.length <= 300 && resSingle.text.length >= 290, `got ${resSingle.text.length}`);
    assert.match(resSingle.text, /^Error: a+/);
    assert.match(resSingle.text, / \.\.\. /);
    assert.match(resSingle.text, /REAL_CAUSE_AT_END$/);

    // Same oversized error line preceded by 50 neutral lines
    const withPrefix = [
      ...Array.from({ length: 50 }, (_, i) => `neutral step ${i}`),
      singleLine,
    ].join("\n");
    const resPrefixed = formatCompactCommandOutputWithMeta({
      stdout: withPrefix,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 300,
    });
    assert.equal(resPrefixed.truncated, true);
    assert.ok(resPrefixed.text.length <= 300 && resPrefixed.text.length >= 285, `got ${resPrefixed.text.length}`);
    assert.match(resPrefixed.text, /\.\.\. \(50 lines omitted\) \.\.\./);
    assert.match(resPrefixed.text, /Error: a+/);
    assert.match(resPrefixed.text, /REAL_CAUSE_AT_END$/);

    // Surrogate safety when splitting an emoji-heavy single oversized error line
    const emojiSingle = `Error: ${"🚀".repeat(250)} END_ROCKET`;
    const resEmoji = formatCompactCommandOutput({
      stdout: emojiSingle,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 240,
    });
    assert.ok(resEmoji.length <= 240);
    assert.match(resEmoji, /END_ROCKET$/);
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(resEmoji),
      false,
    );
  });

  it("stays linear-time (no quadratic ReDoS) on adversarial 60K-char inputs", () => {
    const adversarialLines = [
      `asset ${"a".repeat(60_000)}`,
      `Tests${" ".repeat(60_000)}X`,
      `Tests ${"1".repeat(60_000)}X`,
      `built ${"(".repeat(25_000)}${" ".repeat(25_000)}X`,
      `${"⎯".repeat(50_000)}x`,
      ...Array.from({ length: 16 }, (_, i) => `tail line ${i}`),
    ];

    const start = performance.now();
    const res = formatCompactCommandOutputWithMeta({
      stdout: adversarialLines.join("\n"),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 1000,
    });
    const elapsedMs = performance.now() - start;

    assert.ok(elapsedMs < 500, `Expected linear-time < 500ms on adversarial input, took ${elapsedMs.toFixed(1)}ms`);
    assert.ok(res.text.length <= 1000);
    assert.match(res.text, /tail line 15/);
  });
});
