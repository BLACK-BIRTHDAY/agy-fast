import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runChecks } from "../src/tools/run-checks.js";
import { getSpillDir } from "../src/utils/spill.js";
import {
  buildPowerShellUtf8Command,
  decodeProcessOutput,
  execBinaryAsync,
  formatPowerShellCommand,
  needsPowerShellOnWindows,
  parseWindowsCodePage,
  resetWindowsShellCache,
  resolveWindowsPowerShell,
} from "../src/utils/exec-utils.js";

describe("run_checks", () => {
  const nodeBin = JSON.stringify(process.execPath);
  let suiteCacheDir: string;
  let prevSuiteCacheDir: string | undefined;

  before(async () => {
    suiteCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-checks-cache-"));
    prevSuiteCacheDir = process.env.AGY_FAST_CACHE_DIR;
    process.env.AGY_FAST_CACHE_DIR = suiteCacheDir;
  });

  after(async () => {
    if (prevSuiteCacheDir === undefined) delete process.env.AGY_FAST_CACHE_DIR;
    else process.env.AGY_FAST_CACHE_DIR = prevSuiteCacheDir;
    await fs.rm(suiteCacheDir, { recursive: true, force: true });
  });

  it("executes multiple commands concurrently and compacts passing output", async () => {
    const start = Date.now();
    const res = await runChecks({
      concurrency: 3,
      outputMode: "compact",
      commands: [
        {
          name: "c1",
          command: `${nodeBin} -e "setTimeout(() => console.log('line1\\nline2\\nAll 10 tests passed'), 180)"`,
        },
        {
          name: "c2",
          command: `${nodeBin} -e "setTimeout(() => console.log('Build done in 0.2s'), 180)"`,
        },
        {
          name: "c3",
          command: `${nodeBin} -e "setTimeout(() => console.log('0 errors'), 180)"`,
        },
      ],
    });
    const elapsed = Date.now() - start;

    assert.equal(res.isError, false);
    assert.match(res.text, /Checks: 3\/3 passed/);
    assert.match(res.text, /\[PASS \d+ms\] c1/);
    assert.match(res.text, /All 10 tests passed/);
    // Should clearly execute concurrently rather than 3 * 180ms = 540ms+ serially
    assert.ok(elapsed < 480, `Expected concurrent execution <480ms, got ${elapsed}ms`);
  });

  it("extracts error lines on failure and strips ANSI escape codes", async () => {
    const script = [
      "for (let i = 0; i < 40; i++) console.log('info step ' + i);",
      "console.error('\\x1b[31mError: TS2322 type mismatch at src/a.ts:12\\x1b[0m');",
      "console.log('progress 10%\\rprogress 100%');",
      "process.exit(2);",
    ].join(" ");

    const res = await runChecks({
      outputMode: "compact",
      commands: [{ name: "typecheck", command: `${nodeBin} -e "${script}"` }],
    });

    assert.equal(res.isError, false);
    assert.match(res.text, /Checks: 0\/1 passed, 1 failed/);
    assert.match(res.text, /FAIL \(exit 2\)/);
    assert.match(res.text, /Error: TS2322 type mismatch/);
    assert.doesNotMatch(res.text, /\x1b\[31m/);
    assert.match(res.text, /progress 100%/);
  });

  it("enforces command timeouts cleanly", async () => {
    const res = await runChecks({
      timeoutSec: 1,
      commands: [
        {
          name: "hang",
          command: `${nodeBin} -e "setTimeout(() => console.log('never'), 10000)"`,
        },
      ],
    });

    assert.equal(res.isError, false);
    assert.match(res.text, /TIMEOUT/);
  });

  it("finishes within the shared call budget and reports commands that never started", async () => {
    const budgetMs = 2_000;
    const start = Date.now();
    const res = await runChecks(
      {
        concurrency: 1,
        timeoutSec: 5,
        commands: [
          { name: "quick", command: `${nodeBin} -e "setTimeout(() => console.log('ok'), 300)"` },
          { name: "hang", command: `${nodeBin} -e "setTimeout(() => {}, 10000)"` },
          { name: "late", command: `${nodeBin} -e "console.log('late')"` },
        ],
      },
      budgetMs,
    );
    const elapsed = Date.now() - start;

    assert.ok(elapsed < budgetMs + 1_000, `call took ${elapsed}ms`);
    assert.match(res.text, /^Checks: 1\/3 passed, 1 failed, 1 not run \(call time budget of 2s used up/);
    assert.match(res.text, /\[PASS \d+ms\] quick/);
    assert.match(res.text, /## \[TIMEOUT \d+ms\] hang/);
    assert.match(res.text, /## \[NOT RUN\] late/);
  });

  it("supports full output mode and rejects invalid inputs", async () => {
    const full = await runChecks({
      outputMode: "full",
      commands: [`${nodeBin} -e "console.log('alpha\\nbeta\\ngamma')"`],
    });
    assert.equal(full.isError, false);
    assert.match(full.text, /alpha\nbeta\ngamma/);

    const empty = await runChecks({ commands: [] });
    assert.equal(empty.isError, true);

    const badSubCwd = await runChecks({
      commands: [{ name: "badcwd", command: "echo hi", cwd: "/nonexistent-agy-fast-dir-12345" }],
    });
    assert.equal(badSubCwd.isError, true);
    assert.match(badSubCwd.text, /does not exist/);

    // Non-string commands[i].cwd returns a clean validation error; boolean timeoutSec falls back
    const nonStrSubCwd = await runChecks({
      commands: [{ name: "bad-type", command: `${nodeBin} -e "0"`, cwd: 123 as unknown as string }],
    });
    assert.equal(nonStrSubCwd.isError, true);
    assert.match(nonStrSubCwd.text, /commands\[0\]\.cwd must be a string/);

    const boolTimeout = await runChecks({
      timeoutSec: false as unknown as number,
      commands: [{ name: "bool-timeout", command: `${nodeBin} -e "setTimeout(() => console.log('ok'), 1150)"` }],
    });
    assert.equal(boolTimeout.isError, false);
    assert.match(boolTimeout.text, /1\/1 passed/);
  });

  it("captures npm ERR! lines and respects tight maxChars across multiple failures", async () => {
    const npmErrScript = [
      "for (let i = 0; i < 80; i++) console.log('verbose build step number ' + i + ' padding padding');",
      "console.error('npm ERR! code ELIFECYCLE');",
      "console.error('npm ERR! errno 1');",
      "for (let i = 0; i < 40; i++) console.log('trailing line ' + i + ' padding padding');",
      "process.exit(1);",
    ].join(" ");

    const res = await runChecks({
      outputMode: "compact",
      maxChars: 1200,
      commands: [
        { name: "npm-fail-1", command: `${nodeBin} -e "${npmErrScript}"` },
        { name: "npm-fail-2", command: `${nodeBin} -e "console.error('FAIL_TWO_MARKER'); process.exit(1)"` },
      ],
    });
    assert.equal(res.isError, false);
    assert.ok(res.text.length <= 1200, `Exceeded maxChars: ${res.text.length}`);
    assert.match(res.text, /npm ERR! code ELIFECYCLE/);
    assert.match(res.text, /FAIL_TWO_MARKER/);
  });

  it("circuit-breaks corrupted commands (boolean/null) and accepts stringified JSON arrays", async () => {
    const bad = await runChecks({
      commands: [true, null] as unknown as never[],
    });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /nested argument serialization corruption/i);
    assert.match(bad.text, /commands\[0\]: received boolean \(true\)/);
    assert.match(bad.text, /commands\[1\]: received null/);

    const ok = await runChecks({
      commands: JSON.stringify([{ name: "json-ok", command: `${nodeBin} -e "console.log('ok')"` }]) as unknown as never[],
    });
    assert.equal(ok.isError, false);
    assert.match(ok.text, /\[PASS/);
  });

  it("water-fills unused budget from empty commands to rich commands in full mode (no maxChars/N pre-cut)", async () => {
    const richCmd = (tag: string) =>
      `${nodeBin} -e "for (let i = 0; i < 60; i++) console.log('${tag}_LINE_' + String(i).padStart(2, '0') + '_' + 'x'.repeat(30));"`;

    const res = await runChecks({
      outputMode: "full",
      maxChars: 8000,
      concurrency: 4,
      commands: [
        { name: "empty-1", command: `${nodeBin} -e "console.log('[]')"` },
        { name: "empty-2", command: `${nodeBin} -e "console.log('[]')"` },
        { name: "empty-3", command: `${nodeBin} -e "console.log('[]')"` },
        { name: "empty-4", command: `${nodeBin} -e "console.log('[]')"` },
        { name: "rich-1", command: richCmd("RICH1") },
        { name: "rich-2", command: richCmd("RICH2") },
        { name: "rich-3", command: richCmd("RICH3") },
        { name: "rich-4", command: richCmd("RICH4") },
      ],
    });

    assert.equal(res.isError, false);
    assert.ok(res.text.length <= 8000, `Exceeded maxChars: ${res.text.length}`);
    assert.ok(Buffer.byteLength(res.text, "utf8") <= 8_800);
    // Naive maxChars/8 would have capped each rich command below ~990 chars (< 23 lines).
    // Water-filling donates unused budget from the 4 empty commands so each rich command gets > 1500 chars!
    for (const tag of ["RICH1", "RICH2", "RICH3", "RICH4"]) {
      const matches = res.text.match(new RegExp(`${tag}_LINE_\\d{2}_`, "g")) ?? [];
      assert.ok(
        matches.length >= 35,
        `Expected >= 35 lines for ${tag} (proving budget flowed past maxChars/8), got ${matches.length}`,
      );
    }
  });

  it("uses tiered PASS+FAIL 2-pass water-filling in compact mode and enforces <= 8800 UTF-8 bytes with CJK", async () => {
    const longFailScript = [
      "console.log('> @app/web@1.0.0 build');",
      "console.log('> vite build');",
      "console.log('vite v5.4.0 building for production...');",
      "console.log('transforming...');",
      "console.log('✓ 40 modules transformed.');",
      "console.log('rendering chunks...');",
      "console.log('computing gzip size...');",
      "for (let i = 0; i < 15; i++) console.log('dist/assets/chunk-' + i + '.js   12.34 kB │ gzip: 4.12 kB');",
      "console.log('✓ built in 1.10s');",
      "console.error('src/root.ts(1,1): error TS2304: FIRST_LONG_FAIL_ROOT');",
      "for (let i = 0; i < 45; i++) console.error('src/mid-' + i + '.ts(10,2): error TS2322: cascade line ' + i + ' ' + 'a'.repeat(30));",
      "console.error('src/end.ts(99,5): error TS2345: FINAL_LONG_FAIL_TAIL');",
      "process.exit(1);",
    ].join(" ");

    const res = await runChecks({
      outputMode: "compact",
      maxChars: 2400,
      commands: [
        {
          name: "pass-verbose",
          command: `${nodeBin} -e "console.log('PASS_SUMMARY: ' + 'p'.repeat(420) + ' passed')"`,
        },
        {
          name: "fail-short",
          command: `${nodeBin} -e "console.error('Error: SHORT_FAIL_ONLY'); process.exit(1)"`,
        },
        {
          name: "fail-long",
          command: `${nodeBin} -e ${JSON.stringify(longFailScript)}`,
        },
      ],
    });

    assert.equal(res.isError, false);
    assert.ok(res.text.length <= 2400, `Exceeded maxChars: ${res.text.length}`);
    // PASS line stays capped <= 300 body chars
    const passLine = res.text.split("\n").find((l) => l.includes("pass-verbose")) ?? "";
    assert.ok(passLine.length > 0 && passLine.length < 440, `PASS line too long: ${passLine.length}`);
    // Short FAIL stays intact and donates unused budget to fail-long
    assert.match(res.text, /Error: SHORT_FAIL_ONLY/);
    // Long FAIL keeps BOTH first root error AND final tail error and gets > 1400 chars (well above equal 1050 split)
    assert.match(res.text, /FIRST_LONG_FAIL_ROOT/);
    assert.match(res.text, /FINAL_LONG_FAIL_TAIL/);
    const longFailSection = res.text.split("## [FAIL")[2] ?? "";
    assert.ok(
      longFailSection.length > 1400,
      `Expected fail-long to receive water-filled budget > 1400 chars, got ${longFailSection.length}`,
    );

    // Strict <= 8,800 UTF-8 byte enforcement on CJK output in both compact & full modes
    const cjkFailScript = [
      "console.error('Error: 首个中文根因错误_CJK_ROOT');",
      "for (let i = 0; i < 220; i++) console.error('Error: 中文编译报错详情行_' + i + '_类型不匹配需要检查字段定义和接口约束');",
      "console.error('Error: 最终中文尾部错误_CJK_TAIL_END');",
      "process.exit(1);",
    ].join(" ");
    const cjkCompact = await runChecks({
      outputMode: "compact",
      maxChars: 8000,
      commands: [
        { name: "cjk-fail", command: `${nodeBin} -e ${JSON.stringify(cjkFailScript)}` },
      ],
    });
    assert.equal(cjkCompact.isError, false);
    const compactBytes = Buffer.byteLength(cjkCompact.text, "utf8");
    assert.ok(compactBytes <= 8_800, `Expected <= 8800 UTF-8 bytes, got ${compactBytes}`);
    assert.match(cjkCompact.text, /首个中文根因错误_CJK_ROOT/);
    assert.match(cjkCompact.text, /最终中文尾部错误_CJK_TAIL_END/);
    assert.doesNotMatch(cjkCompact.text, /\uFFFD/);

    const cjkFull = await runChecks({
      outputMode: "full",
      maxChars: 8000,
      commands: [
        { name: "cjk-full-1", command: `${nodeBin} -e "console.log('[]')"` },
        { name: "cjk-full-2", command: `${nodeBin} -e ${JSON.stringify(cjkFailScript)}` },
      ],
    });
    assert.equal(cjkFull.isError, false);
    assert.ok(Buffer.byteLength(cjkFull.text, "utf8") <= 8_800);
    assert.doesNotMatch(cjkFull.text, /\uFFFD/);
  });

  it("prevents PASS-heavy batches from starving FAIL output and prevents separator overshoot on tight all-fail batches", async () => {
    // Repro A: 10 verbose PASS commands + 1 FAIL command (with a long command line) at maxChars: 2500
    const passCmds = Array.from({ length: 10 }, (_, i) => ({
      name: `pass-${i}`,
      command: `${nodeBin} -e "console.log('PASS_${i}_SUMMARY: ' + 'p'.repeat(280) + ' passed')"`,
    }));
    const longFailCmd = `${nodeBin} -e "const pad = '${"x".repeat(140)}'; console.error('Error: STARVATION_GUARD_ROOT_CAUSE'); for (let i = 0; i < 8; i++) console.error('Error: detail line ' + i); console.error('Error: STARVATION_GUARD_TAIL_CAUSE'); process.exit(1);"`;

    const resA = await runChecks({
      outputMode: "compact",
      maxChars: 2500,
      concurrency: 4,
      commands: [
        ...passCmds,
        { name: "sole-fail", command: longFailCmd },
      ],
    });
    assert.equal(resA.isError, false);
    assert.ok(resA.text.length <= 2500, `Exceeded maxChars: ${resA.text.length}`);
    assert.ok(Buffer.byteLength(resA.text, "utf8") <= 8_800);
    // FAIL command must NOT be starved to 0 error chars — both root & tail errors must survive
    assert.match(resA.text, /STARVATION_GUARD_ROOT_CAUSE/);
    assert.match(resA.text, /STARVATION_GUARD_TAIL_CAUSE/);
    for (let i = 0; i < 10; i++) {
      assert.match(resA.text, new RegExp(`\\[PASS \\d+ms\\] pass-${i}`));
    }

    // Repro B: 10 FAIL commands at tight maxChars: 550 must respect separator budget and preserve tail markers
    const failCmds = Array.from({ length: 10 }, (_, i) => ({
      name: `f${i}`,
      command: `${nodeBin} -e "console.error('noise '.repeat(20) + '\\nTAIL_M${i}'); process.exit(1)"`,
    }));
    const resB = await runChecks({
      outputMode: "compact",
      maxChars: 550,
      concurrency: 4,
      commands: failCmds,
    });
    assert.equal(resB.isError, false);
    assert.ok(resB.text.length <= 550, `Exceeded maxChars: ${resB.text.length}`);
    assert.ok(Buffer.byteLength(resB.text, "utf8") <= 8_800);
    for (let i = 0; i < 10; i++) {
      assert.match(
        resB.text,
        new RegExp(`TAIL_M${i}`),
        `Expected tail marker TAIL_M${i} to survive tight 10-fail batch:\n${resB.text}`,
      );
    }
  });

  it("detects PowerShell syntax vs cross-platform commands and formats quoted executables", () => {
    assert.equal(
      needsPowerShellOnWindows('node "$env:USERPROFILE\\.gemini\\dist\\benchmark.mjs" --help'),
      true,
    );
    assert.equal(
      needsPowerShellOnWindows('node "$Env:USERPROFILE\\dist\\benchmark.mjs" --help'),
      true,
    );
    assert.equal(
      needsPowerShellOnWindows("echo $ENV:PATH; echo $LastExitCode"),
      true,
    );
    assert.equal(
      needsPowerShellOnWindows("Get-ChildItem src | Select-Object -First 5"),
      true,
    );
    assert.equal(
      needsPowerShellOnWindows("if (Test-Path dist) { Write-Output $LASTEXITCODE }"),
      true,
    );
    assert.equal(needsPowerShellOnWindows("$x = 1; echo $x"), true);
    assert.equal(needsPowerShellOnWindows("echo $(Get-Date)"), true);
    assert.equal(needsPowerShellOnWindows('@("a", "b") -join ","'), true);

    // Cross-platform CLI tools and quoted patterns must NOT false-positive as PowerShell
    assert.equal(needsPowerShellOnWindows("npm test"), false);
    assert.equal(needsPowerShellOnWindows("npm run test-unit"), false);
    assert.equal(needsPowerShellOnWindows("start-server-and-test dev 3000 test"), false);
    assert.equal(needsPowerShellOnWindows("copy-webpack-plugin --version"), false);
    assert.equal(needsPowerShellOnWindows("wait-on http://localhost:3000 && npm test"), false);
    assert.equal(needsPowerShellOnWindows("start-storybook -p 6006"), false);
    assert.equal(needsPowerShellOnWindows("copy-files src dist"), false);
    assert.equal(needsPowerShellOnWindows("npm run build && test-runner"), false);
    assert.equal(needsPowerShellOnWindows('git log --grep="(set-cookie)"'), false);
    assert.equal(needsPowerShellOnWindows('git log --grep="(Get-Item)"'), false);
    assert.equal(needsPowerShellOnWindows('rg "(get-user|set-user)" src/'), false);
    assert.equal(
      needsPowerShellOnWindows('node -e "console.log(JSON.stringify({ msg: \\"(get-id)\\" }))"'),
      false,
    );
    assert.equal(needsPowerShellOnWindows("echo '$env:PATH'"), false);
    assert.equal(needsPowerShellOnWindows('rg "\\$env:FOO" src/'), false);
    assert.equal(
      needsPowerShellOnWindows('"D:\\Program Files\\nodejs\\node.exe" -e "console.log(1)"'),
      false,
    );
    assert.equal(needsPowerShellOnWindows("echo %USERPROFILE%"), false);
    assert.equal(
      needsPowerShellOnWindows('pwsh -NoProfile -Command "Write-Output ok"'),
      false,
    );

    // Quoted executable invocation vs PowerShell string expressions
    assert.equal(
      formatPowerShellCommand('"$Env:USERPROFILE\\bin\\tool.exe" --version'),
      '& "$Env:USERPROFILE\\bin\\tool.exe" --version',
    );
    assert.equal(
      formatPowerShellCommand("'C:\\Tools\\my`tool.exe' --help"),
      "& 'C:\\Tools\\my`tool.exe' --help",
    );
    assert.equal(formatPowerShellCommand('"hello" | Out-Null'), '"hello" | Out-Null');
    assert.equal(formatPowerShellCommand('"$Env:FOO" -eq "bar"'), '"$Env:FOO" -eq "bar"');
    assert.equal(formatPowerShellCommand('"{0}" -f $Env:USERNAME'), '"{0}" -f $Env:USERNAME');
    assert.equal(formatPowerShellCommand('"$Env:PATH".Split(\';\')'), '"$Env:PATH".Split(\';\')');
    assert.equal(formatPowerShellCommand('"$Env:USERPROFILE"[0]'), '"$Env:USERPROFILE"[0]');
    assert.equal(formatPowerShellCommand('"$Env:FOO" > out.txt'), '"$Env:FOO" > out.txt');
    assert.equal(formatPowerShellCommand('"$Env:FOO" 2> err.txt'), '"$Env:FOO" 2> err.txt');
    assert.equal(formatPowerShellCommand('"$Env:FOO" * 3'), '"$Env:FOO" * 3');
    assert.equal(formatPowerShellCommand('"$Env:A", "$Env:B"'), '"$Env:A", "$Env:B"');
    assert.equal(formatPowerShellCommand("'it''s' + $Env:FOO"), "'it''s' + $Env:FOO");
    assert.equal(formatPowerShellCommand('"a""b" -eq $Env:FOO'), '"a""b" -eq $Env:FOO');
    assert.equal(
      formatPowerShellCommand('node "$env:USERPROFILE\\a.js"'),
      'node "$env:USERPROFILE\\a.js"',
    );

    // UTF-8 prefix guards non-console hosts and avoids BOM
    const wrapped = buildPowerShellUtf8Command('Write-Output "ok"');
    assert.match(wrapped, /try \{ \[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\) \} catch \{\}/);
    assert.match(wrapped, /\$OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
    assert.ok(wrapped.endsWith('Write-Output "ok"'));
  });

  it("resolves pwsh -> powershell.exe -> null fallback chain and caches probe results", async () => {
    try {
      resetWindowsShellCache();
      const probed: string[] = [];
      const first = await resolveWindowsPowerShell(async (bin) => {
        probed.push(bin);
        return bin === "pwsh";
      });
      const cached = await resolveWindowsPowerShell(async (bin) => {
        probed.push(`unexpected-${bin}`);
        return false;
      });
      assert.equal(first, "pwsh");
      assert.equal(cached, "pwsh");
      assert.deepEqual(probed, ["pwsh"]);

      resetWindowsShellCache();
      const fallbackProbed: string[] = [];
      const second = await resolveWindowsPowerShell(async (bin) => {
        fallbackProbed.push(bin);
        return bin === "powershell.exe";
      });
      assert.equal(second, "powershell.exe");
      assert.deepEqual(fallbackProbed, ["pwsh", "powershell.exe"]);

      resetWindowsShellCache();
      const noneProbed: string[] = [];
      const third = await resolveWindowsPowerShell(async (bin) => {
        noneProbed.push(bin);
        return false;
      });
      assert.equal(third, null);
      assert.deepEqual(noneProbed, ["pwsh", "powershell.exe"]);
    } finally {
      resetWindowsShellCache();
    }
  });

  it("decodes UTF-8, truncated UTF-8 tails, and legacy codepage buffers cleanly", () => {
    assert.equal(parseWindowsCodePage("Active code page: 936\r\n"), "gb18030");
    assert.equal(parseWindowsCodePage("Active code page: 866\r\n"), "ibm866");
    assert.equal(parseWindowsCodePage("Active code page: 874\r\n"), "windows-874");
    assert.equal(parseWindowsCodePage("Active code page: 1253\r\n"), "windows-1253");
    assert.equal(parseWindowsCodePage("Active code page: 1255\r\n"), "windows-1255");
    assert.equal(parseWindowsCodePage("Active code page: 1257\r\n"), "windows-1257");
    assert.equal(parseWindowsCodePage("Active code page: 1258\r\n"), "windows-1258");
    assert.equal(parseWindowsCodePage("Active code page: 65001\r\n"), null);
    assert.equal(parseWindowsCodePage("no digits here"), null);

    const utf8 = Buffer.from("中文 UTF-8 输出 OK", "utf8");
    assert.equal(decodeProcessOutput(utf8, false, "gb18030"), "中文 UTF-8 输出 OK");

    // Simulate maxOutputBytes cutting a 3-byte UTF-8 character mid-sequence
    const midCut = Buffer.concat([Buffer.from("中文", "utf8"), Buffer.from([0xe8, 0xbe])]);
    assert.equal(decodeProcessOutput(midCut, true, "gb18030"), "中文");

    // GBK bytes for "'x' 不是"
    const gbk = Buffer.from("27782720b2bbcac7", "hex");
    assert.equal(decodeProcessOutput(gbk, false, "gb18030"), "'x' 不是");
  });

  if (process.platform === "win32") {
    it("executes PowerShell $env: variables, UTF-8 Unicode output, and cmdlets cleanly on Windows", async () => {
      const prev = process.env.AGY_FAST_PWSH_TEST;
      process.env.AGY_FAST_PWSH_TEST = "pwsh_env_expanded_ok";
      try {
        const res = await runChecks({
          outputMode: "full",
          commands: [
            {
              name: "win-ps-env",
              command: `${nodeBin} -e "console.log(process.argv[1])" "$Env:AGY_FAST_PWSH_TEST"`,
            },
            {
              name: "win-ps-unicode",
              command: 'Write-Output "✔ 🚀 $Env:AGY_FAST_PWSH_TEST"',
            },
            {
              name: "win-missing-cmd-encoding",
              command: "agy_fast_nonexistent_cmd_xyz --version",
            },
          ],
        });
        assert.equal(res.isError, false);
        assert.match(res.text, /Checks: 2\/3 passed, 1 failed/);
        assert.match(res.text, /✔ 🚀 pwsh_env_expanded_ok/);
        assert.doesNotMatch(res.text, /\uFFFD/);
      } finally {
        if (prev === undefined) {
          delete process.env.AGY_FAST_PWSH_TEST;
        } else {
          process.env.AGY_FAST_PWSH_TEST = prev;
        }
      }
    });

    it("falls back cleanly without crashing when taskkill is unavailable on command timeout", async () => {
      const savedEnv = { ...process.env };
      const savedPath = process.env.PATH;
      const savedSystemRoot = process.env.SystemRoot;
      const savedWindir = process.env.WINDIR;
      try {
        // 1. Empty PATH with intact SystemRoot resolves System32\taskkill.exe directly
        process.env.PATH = "";
        const resWithSysRoot = await execBinaryAsync(
          process.execPath,
          ["-e", "setTimeout(() => {}, 10000)"],
          { cwd: process.cwd(), timeoutMs: 250, env: savedEnv },
        );
        assert.equal(resWithSysRoot.timedOut, true);
        assert.notEqual(resWithSysRoot.signal, "SIGKILL");
        assert.ok(resWithSysRoot.durationMs < 1400, `expected prompt termination, got ${resWithSysRoot.durationMs}ms`);

        // 2. Empty PATH + missing SystemRoot/WINDIR emits async spawn ENOENT, handled by error listener + fallbackKill
        delete process.env.SystemRoot;
        delete process.env.WINDIR;
        const resNoTaskkill = await execBinaryAsync(
          process.execPath,
          ["-e", "setTimeout(() => {}, 10000)"],
          { cwd: process.cwd(), timeoutMs: 250, env: savedEnv },
        );
        assert.equal(resNoTaskkill.timedOut, true);
        assert.notEqual(resNoTaskkill.signal, "SIGKILL");
        assert.ok(resNoTaskkill.durationMs < 1400, `expected fallbackKill before settle timer, got ${resNoTaskkill.durationMs}ms`);

        // 3. Invalid SystemRoot (nonexistent bin + invalid cwd) also emits async ENOENT handled by fallbackKill
        process.env.SystemRoot = path.join(os.tmpdir(), "agy-fast-nonexistent-sysroot");
        const resBadSysRoot = await execBinaryAsync(
          process.execPath,
          ["-e", "setTimeout(() => {}, 10000)"],
          { cwd: process.cwd(), timeoutMs: 250, env: savedEnv },
        );
        assert.equal(resBadSysRoot.timedOut, true);
        assert.notEqual(resBadSysRoot.signal, "SIGKILL");
        assert.ok(resBadSysRoot.durationMs < 1400, `expected fallbackKill before settle timer, got ${resBadSysRoot.durationMs}ms`);
      } finally {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
        if (savedSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = savedSystemRoot;
        if (savedWindir === undefined) delete process.env.WINDIR;
        else process.env.WINDIR = savedWindir;
      }
    });
  }

  it("spills full output lazily on truncation or >=20 folded lines, stays within budgets, and honors AGY_FAST_SPILL=off", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-checks-spill-"));
    const prevCache = process.env.AGY_FAST_CACHE_DIR;
    const prevSpill = process.env.AGY_FAST_SPILL;
    process.env.AGY_FAST_CACHE_DIR = cacheDir;
    delete process.env.AGY_FAST_SPILL;

    try {
      // 1. Small inline output (including noise-filtered warning & <20 folded green lines) -> lazy, zero spill files created
      const smallFoldScript = [
        "console.log('> @app/pkg@1.0.0 build');",
        "console.log('vite v5.4.1 building for production...');",
        "console.log('transforming...');",
        "console.log('✓ 12 modules transformed.');",
        "console.log('rendering chunks...');",
        "console.log('✓ built in 0.42s');",
        "for (let i = 0; i < 15; i++) console.error('src/small.ts(' + (i + 1) + ',1): error TS2322: SMALL_FOLD_ERR_' + i);",
        "process.exit(1);",
      ].join(" ");
      const inlineRes = await runChecks({
        outputMode: "compact",
        commands: [
          { name: "ok-1", command: `${nodeBin} -e "console.log('10 tests passed')"` },
          {
            name: "warn-fail",
            command: `${nodeBin} -e "console.error('(node:1234) ExperimentalWarning: foo\\nError: minor'); process.exit(1)"`,
          },
          {
            name: "small-fold-fail",
            command: `${nodeBin} -e ${JSON.stringify(smallFoldScript)}`,
          },
        ],
      });
      assert.equal(inlineRes.isError, false);
      assert.match(inlineRes.text, /\.\.\. \(collapsed [4-9] build\/pass lines/);
      assert.doesNotMatch(inlineRes.text, /\[full output spilled:/);
      await assert.rejects(() => fs.lstat(getSpillDir()), { code: "ENOENT" });

      // 2. Full mode truncation -> unified spill file with exact readable ranges + redaction
      const fullRes = await runChecks({
        outputMode: "full",
        maxChars: 1400,
        commands: [
          { name: "tiny-ok", command: `${nodeBin} -e "console.log('TINY_OK_LINE')"` },
          {
            name: "verbose-cmd",
            command: `${nodeBin} -e "console.log('ghp_' + 'a1B2'.repeat(9)); for (let i = 0; i < 80; i++) console.log('FULL_LINE_' + i + '_' + 'x'.repeat(25));"`,
          },
        ],
      });
      assert.equal(fullRes.isError, false);
      assert.ok(fullRes.text.length <= 1400, `Exceeded maxChars: ${fullRes.text.length}`);
      assert.ok(Buffer.byteLength(fullRes.text, "utf8") <= 8_800);

      const fullMatch = fullRes.text.match(
        /\[full output spilled: (.+?) \((\d+) lines\) — read_file ranges: verbose-cmd L(\d+)-L(\d+)\]/,
      );
      assert.ok(fullMatch, `Expected spill footer prioritizing verbose-cmd, got:\n${fullRes.text}`);
      const fullSpillLines = (await fs.readFile(fullMatch[1]!, "utf8")).split("\n");
      assert.equal(fullSpillLines.length, Number(fullMatch[2]));
      const verboseSlice = fullSpillLines.slice(Number(fullMatch[3]) - 1, Number(fullMatch[4]));
      assert.equal(verboseSlice[0], "=== verbose-cmd ===");
      assert.equal(verboseSlice[1], "[REDACTED]");
      assert.ok(verboseSlice.some((l) => l.startsWith("FULL_LINE_0_")));
      assert.ok(verboseSlice.some((l) => l.startsWith("FULL_LINE_79_")));
      assert.equal(fullSpillLines.some((l) => l.includes("ghp_a1B2")), false);
      // Both commands are in the unified spill file
      assert.equal(fullSpillLines[0], "=== tiny-ok ===");
      assert.equal(fullSpillLines[1], "TINY_OK_LINE");

      // 3. Compact mode failure folding >= 20 green lines triggers spill even when raw output fits under maxChars
      const foldScript = [
        "console.log('> @app/pkg@1.0.0 build');",
        "console.log('vite v5.4.1 building for production...');",
        "for (let i = 0; i < 24; i++) console.log('dist/chunk-' + i + '.js   11.20 kB │ gzip: 3.40 kB');",
        "console.log('✓ built in 1.05s');",
        "for (let i = 0; i < 15; i++) console.error('src/a.ts(' + (i + 1) + ',1): error TS2322: COMPACT_FOLD_ERR_' + i);",
        "process.exit(1);",
      ].join(" ");
      const foldRes = await runChecks({
        outputMode: "compact",
        maxChars: 6000,
        commands: [
          { name: "lint", command: `${nodeBin} -e "console.log('0 errors')"` },
          { name: "build-fold", command: `${nodeBin} -e ${JSON.stringify(foldScript)}` },
        ],
      });
      assert.equal(foldRes.isError, false);
      assert.ok(foldRes.text.length <= 6000);
      assert.ok(Buffer.byteLength(foldRes.text, "utf8") <= 8_800);
      assert.match(foldRes.text, /\.\.\. \(collapsed \d+ build\/pass lines/);
      const foldMatch = foldRes.text.match(
        /\[full output spilled: (.+?) \((\d+) lines\) — read_file ranges: build-fold L(\d+)-L(\d+)\]/,
      );
      assert.ok(foldMatch, `Expected spill footer for >=20 folded lines, got:\n${foldRes.text}`);
      const foldLines = (await fs.readFile(foldMatch[1]!, "utf8")).split("\n");
      const buildSlice = foldLines.slice(Number(foldMatch[3]) - 1, Number(foldMatch[4]));
      assert.equal(buildSlice[0], "=== build-fold ===");
      assert.ok(buildSlice.some((l) => l.includes("dist/chunk-0.js")));
      assert.ok(buildSlice.some((l) => l.includes("dist/chunk-23.js")));
      assert.ok(buildSlice.some((l) => l.includes("COMPACT_FOLD_ERR_14")));

      // 4. CJK compact truncation stays strictly <= 8,800 UTF-8 bytes with footer and zero lone surrogates
      const cjkScript = [
        "console.error('Error: 中文根因错误_SPILL_HEAD');",
        "for (let i = 0; i < 230; i++) console.error('Error: 中文详情_' + i + '_🚀_编译报错信息内容用于验证字节上限');",
        "console.error('Error: 中文尾部错误_SPILL_TAIL');",
        "process.exit(1);",
      ].join(" ");
      const cjkRes = await runChecks({
        outputMode: "compact",
        maxChars: 8000,
        commands: [{ name: "cjk-check", command: `${nodeBin} -e ${JSON.stringify(cjkScript)}` }],
      });
      assert.equal(cjkRes.isError, false);
      assert.ok(cjkRes.text.length <= 8000);
      assert.ok(Buffer.byteLength(cjkRes.text, "utf8") <= 8_800);
      assert.equal(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cjkRes.text),
        false,
      );
      assert.match(cjkRes.text, /\[full output spilled: .+? — read_file ranges: cjk-check L1-L\d+\]/);

      // 5. AGY_FAST_SPILL=off suppresses spilling completely
      const offCache = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-checks-spill-off-"));
      try {
        process.env.AGY_FAST_CACHE_DIR = offCache;
        process.env.AGY_FAST_SPILL = "off";
        const offRes = await runChecks({
          outputMode: "full",
          maxChars: 1200,
          commands: [
            {
              name: "big",
              command: `${nodeBin} -e "for (let i = 0; i < 80; i++) console.log('LINE_' + i + '_' + 'y'.repeat(30));"`,
            },
          ],
        });
        assert.equal(offRes.isError, false);
        assert.ok(offRes.text.length <= 1200);
        assert.doesNotMatch(offRes.text, /\[full output spilled:/);
        await assert.rejects(() => fs.lstat(getSpillDir()), { code: "ENOENT" });
      } finally {
        await fs.rm(offCache, { recursive: true, force: true });
      }
    } finally {
      if (prevCache === undefined) delete process.env.AGY_FAST_CACHE_DIR;
      else process.env.AGY_FAST_CACHE_DIR = prevCache;
      if (prevSpill === undefined) delete process.env.AGY_FAST_SPILL;
      else process.env.AGY_FAST_SPILL = prevSpill;
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });
});
