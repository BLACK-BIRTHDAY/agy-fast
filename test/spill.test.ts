import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import {
  SPILL_FILENAME_REGEX,
  SPILL_MAX_BYTES,
  SPILL_MAX_FILES,
  SPILL_TTL_MS,
  formatSpillFooter,
  getSpillDir,
  isSpillEnabled,
  redactSecrets,
  writeSpillFile,
} from "../src/utils/spill.js";

const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("spill utilities", () => {
  it("redacts all secret token families and PEM private keys while leaving benign text intact", () => {
    const ghp = `ghp_${"a1B2".repeat(9)}`;
    const gho = `gho_${"Z9y8".repeat(6)}`;
    const ghu = `ghu_${"1234abcd".repeat(3)}`;
    const ghs = `ghs_${"QWERasdf".repeat(3)}`;
    const ghr = `ghr_${"9876mnop".repeat(3)}`;
    const ghPat = `github_pat_${"AbCd_1234".repeat(4)}`;
    const openaiKey = `sk-${"proj1234567890ABCDEF"}`;
    const anthropicKey = `sk-ant-${"api03_abcdefghij1234567890"}`;
    const googleKey = `AIza${"0123456789abcdefGHIJKLMNOPQRSTuvwxy"}`; // 35 chars
    const awsAkia = "AKIAIOSFODNN7EXAMPLE";
    const awsAsia = "ASIA1234567890ABCDEF";
    const slackBot = "xoxb-123456789012-abcdefghij";
    const slackUser = "xoxp-9988776655-qwertyuiop";
    const bearerLong = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";

    const pemRsa = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAnFakeKeyBodyLine1",
      "MIIEowIBAAKCAQEAnFakeKeyBodyLine2",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const pemOpenssh = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const benignCert = [
      "-----BEGIN CERTIFICATE-----",
      "MIIDPublicCertDataNotAPrivateKey",
      "-----END CERTIFICATE-----",
    ].join("\n");

    const sample = [
      `Authorization: Bearer shorttok123`,
      `{"authorization": "Bearer ${bearerLong}"}`,
      `Bearer ${bearerLong}`,
      `Bearer shortword`,
      `gh=${ghp} ${gho} ${ghu} ${ghs} ${ghr} ${ghPat}`,
      `ai=${openaiKey} ${anthropicKey} ${googleKey}`,
      `aws=${awsAkia} ${awsAsia}`,
      `slack=${slackBot} ${slackUser}`,
      pemRsa,
      `middle safe line: {"ok": true, "count": 42, "url": "https://example.com/api/v1"}`,
      pemOpenssh,
      benignCert,
      `sk-tooshort123`,
      `unclosed -----BEGIN PRIVATE KEY----- mention in docs`,
    ].join("\n");

    const redacted = redactSecrets(sample);

    // Every secret must be completely gone
    for (const secret of [
      "shorttok123",
      bearerLong,
      ghp,
      gho,
      ghu,
      ghs,
      ghr,
      ghPat,
      openaiKey,
      anthropicKey,
      googleKey,
      awsAkia,
      awsAsia,
      slackBot,
      slackUser,
      "MIIEowIBAAKCAQEAnFakeKeyBodyLine1",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=",
    ]) {
      assert.equal(redacted.includes(secret), false, `Secret leaked: ${secret}`);
    }

    // Prefixes and structure preserved cleanly
    assert.match(redacted, /^Authorization: Bearer \[REDACTED\]$/m);
    assert.match(redacted, /\{"authorization": "Bearer \[REDACTED\]"\}/);
    assert.match(redacted, /^Bearer \[REDACTED\]$/m);
    assert.match(redacted, /^Bearer shortword$/m);
    assert.match(redacted, /\[REDACTED PRIVATE KEY\]/);
    assert.equal(redacted.split("[REDACTED PRIVATE KEY]").length - 1, 2);

    // Benign content untouched
    assert.match(redacted, /MIIDPublicCertDataNotAPrivateKey/);
    assert.match(redacted, /middle safe line: \{"ok": true, "count": 42/);
    assert.match(redacted, /sk-tooshort123/);
    assert.match(redacted, /unclosed -----BEGIN PRIVATE KEY----- mention in docs/);

    // Idempotent on already-redacted text
    assert.equal(redactSecrets(redacted), redacted);
  });

  it("runs redactSecrets in strictly O(n) linear time on 60K adversarial ReDoS inputs", () => {
    const adversarialInputs = [
      "-----BEGIN PRIVATE KEY-----\n".repeat(2200),
      `${Array.from({ length: 1800 }, (_, i) => `-----BEGIN K${i} PRIVATE KEY-----\n`).join("")}-----END ZZZ PRIVATE KEY-----`,
      `-----BEGIN ${"-----END ".repeat(18_000)}`,
      `${"-----BEGIN ".repeat(18_000)}\n-----END PRIVATE KEY-----`,
      `Authorization${" ".repeat(60_000)}`,
      `Authorization: Bearer ${" ".repeat(60_000)}`,
      `Bearer ${" ".repeat(60_000)}`,
      `sk-${"-".repeat(60_000)}`,
      `xoxb-${"-".repeat(60_000)}`,
      `github_pat_${"_".repeat(60_000)}!`,
    ];

    const start = performance.now();
    for (const payload of adversarialInputs) {
      const out = redactSecrets(payload);
      assert.equal(typeof out, "string");
    }
    const elapsedMs = performance.now() - start;
    assert.ok(
      elapsedMs < 250,
      `Expected O(n) redaction across 60K adversarial inputs < 250ms, took ${elapsedMs.toFixed(1)}ms`,
    );
  });

  it("resolves isSpillEnabled with AGY_FAST_SPILL env > config.json > default on", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-spill-cfg-"));
    try {
      const baseEnv: NodeJS.ProcessEnv = { AGY_FAST_CACHE_DIR: cacheDir };

      // 1. Default (no config.json, no env) -> true
      assert.equal(isSpillEnabled(baseEnv), true);

      // 2. config.json string/boolean values
      const cfgPath = path.join(cacheDir, "config.json");
      await fs.writeFile(cfgPath, JSON.stringify({ spill: "off" }), "utf8");
      assert.equal(isSpillEnabled(baseEnv), false);

      await fs.writeFile(cfgPath, JSON.stringify({ spill: false }), "utf8");
      assert.equal(isSpillEnabled(baseEnv), false);

      await fs.writeFile(cfgPath, JSON.stringify({ spill: "on" }), "utf8");
      assert.equal(isSpillEnabled(baseEnv), true);

      await fs.writeFile(cfgPath, JSON.stringify({ spill: true }), "utf8");
      assert.equal(isSpillEnabled(baseEnv), true);

      // 3. Env overrides config.json
      await fs.writeFile(cfgPath, JSON.stringify({ spill: "on" }), "utf8");
      for (const val of ["off", "0", "false", " OFF ", "False"]) {
        assert.equal(isSpillEnabled({ ...baseEnv, AGY_FAST_SPILL: val }), false);
      }

      await fs.writeFile(cfgPath, JSON.stringify({ spill: "off" }), "utf8");
      for (const val of ["on", "1", "true", " ON ", "True"]) {
        assert.equal(isSpillEnabled({ ...baseEnv, AGY_FAST_SPILL: val }), true);
      }

      // Unrecognized env falls back to config.json
      assert.equal(isSpillEnabled({ ...baseEnv, AGY_FAST_SPILL: "maybe" }), false);

      // Malformed config.json fails open to true
      await fs.writeFile(cfgPath, "{not-valid-json", "utf8");
      assert.equal(isSpillEnabled(baseEnv), true);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("writes unified sections with exact 1-based line ranges, redaction, and proper permissions", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-spill-lines-"));
    try {
      const env: NodeJS.ProcessEnv = { AGY_FAST_CACHE_DIR: cacheDir };

      // Empty sections or disabled returns null without creating spill dir
      assert.equal(await writeSpillFile({ tool: "run_checks", sections: [], env }), null);
      assert.equal(
        await writeSpillFile({
          tool: "run_checks",
          sections: [{ label: "a", content: "hi" }],
          env: { ...env, AGY_FAST_SPILL: "off" },
        }),
        null,
      );
      await assert.rejects(() => fs.lstat(getSpillDir(env)), { code: "ENOENT" });

      const result = await writeSpillFile({
        tool: "run_checks",
        env,
        sections: [
          {
            label: "lint",
            content: "alpha 1\r\nalpha 2\r\nAuthorization: Bearer secret1234567890\r\n",
            truncated: false,
          },
          {
            label: "typecheck",
            content: "err line 1\nerr line 2\nerr line 3\nerr line 4",
            truncated: true,
          },
          {
            label: "empty-sec",
            content: "",
            truncated: false,
          },
        ],
      });

      assert.ok(result);
      assert.equal(result.capped, false);
      assert.match(path.basename(result.filePath), SPILL_FILENAME_REGEX);

      if (process.platform !== "win32") {
        assert.equal((await fs.stat(getSpillDir(env))).mode & 0o777, 0o700);
        assert.equal((await fs.stat(result.filePath)).mode & 0o777, 0o600);
      }

      const raw = await fs.readFile(result.filePath, "utf8");
      const lines = raw.split("\n");
      assert.equal(lines.length, result.totalLines);
      assert.equal(Buffer.byteLength(raw, "utf8"), result.totalBytes);
      assert.equal(raw.includes("secret1234567890"), false);

      // Verify every section's exact 1-based [startLine, endLine] slice
      const [s1, s2, s3] = result.sections;
      assert.ok(s1 && s2 && s3);
      assert.deepEqual(lines.slice(s1.startLine - 1, s1.endLine), [
        "=== lint ===",
        "alpha 1",
        "alpha 2",
        "Authorization: Bearer [REDACTED]",
      ]);
      assert.deepEqual(lines.slice(s2.startLine - 1, s2.endLine), [
        "=== typecheck ===",
        "err line 1",
        "err line 2",
        "err line 3",
        "err line 4",
      ]);
      assert.deepEqual(lines.slice(s3.startLine - 1, s3.endLine), [
        "=== empty-sec ===",
        "",
      ]);

      // Footer prioritizes truncated sections
      const footer = formatSpillFooter(result);
      assert.ok(footer.startsWith("\n[full output spilled: "));
      assert.match(footer, new RegExp(`read_file ranges: typecheck L${s2.startLine}-L${s2.endLine}\\]$`));
      assert.doesNotMatch(footer, /lint L/);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("enforces the 2 MB surrogate-safe cap and clamps affected section line ranges", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-spill-cap-"));
    try {
      const env: NodeJS.ProcessEnv = { AGY_FAST_CACHE_DIR: cacheDir };
      // Fill > 2 MB with 4-byte emoji and 3-byte CJK to stress UTF-8 & UTF-16 surrogate boundary slicing
      const emojiLine = `行🚀${"测试🔥".repeat(80)}`; // ~807 bytes per line
      const bigBody = Array.from({ length: 2800 }, (_, i) => `${i}:${emojiLine}`).join("\n");

      const result = await writeSpillFile({
        tool: "batch_search",
        env,
        sections: [
          { label: "Query 1", content: "small header match", truncated: false },
          { label: "Query 2", content: bigBody, truncated: true },
          { label: "Query 3", content: "tail section beyond 2MB", truncated: false },
        ],
      });

      assert.ok(result);
      assert.equal(result.capped, true);

      const content = await fs.readFile(result.filePath, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      assert.ok(bytes <= SPILL_MAX_BYTES, `Expected <= ${SPILL_MAX_BYTES} bytes, got ${bytes}`);
      assert.equal(result.totalBytes, bytes);
      assert.ok(content.endsWith("\n... [spill file capped at 2 MB]"));
      assert.equal(LONE_SURROGATE_RE.test(content), false, "Must not contain lone UTF-16 surrogates");
      assert.doesNotMatch(content, /\uFFFD/);

      const lines = content.split("\n");
      assert.equal(lines.length, result.totalLines);
      for (const sec of result.sections) {
        assert.ok(sec.startLine >= 1 && sec.startLine <= sec.endLine && sec.endLine <= result.totalLines);
      }
      assert.equal(result.sections[0]!.startLine, 1);
      assert.equal(result.sections[0]!.endLine, 2);
      assert.equal(result.sections[1]!.endLine, result.totalLines);
      assert.equal(result.sections[2]!.startLine, result.totalLines);
      assert.equal(result.sections[2]!.endLine, result.totalLines);
      assert.equal(result.sections[2]!.truncated, true);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("cleans up >24h expired spill files and enforces the 50-file LRU cap without touching unrelated files", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-spill-gc-"));
    try {
      const env: NodeJS.ProcessEnv = { AGY_FAST_CACHE_DIR: cacheDir };
      const spillDir = getSpillDir(env);
      await fs.mkdir(spillDir, { recursive: true });

      const nowMs = Date.now();
      const expiredName = "run_checks-20250101-000000-000001.log";
      const freshName = "run_checks-20261122-000000-000002.log";
      const unrelatedTxt = "notes.txt";
      const unrelatedLog = "custom-debug.log";

      await fs.writeFile(path.join(spillDir, expiredName), "old\n", "utf8");
      const oldSec = (nowMs - SPILL_TTL_MS - 60_000) / 1000;
      await fs.utimes(path.join(spillDir, expiredName), oldSec, oldSec);

      await fs.writeFile(path.join(spillDir, freshName), "fresh\n", "utf8");
      await fs.writeFile(path.join(spillDir, unrelatedTxt), "keep txt\n", "utf8");
      await fs.utimes(path.join(spillDir, unrelatedTxt), oldSec, oldSec);
      await fs.writeFile(path.join(spillDir, unrelatedLog), "keep log\n", "utf8");
      await fs.utimes(path.join(spillDir, unrelatedLog), oldSec, oldSec);

      // First write triggers TTL cleanup (and must not delete itself even with future nowMs)
      const res1 = await writeSpillFile({
        tool: "run_checks",
        sections: [{ label: "a", content: "hello", truncated: true }],
        env,
        nowMs,
      });
      assert.ok(res1);
      const afterTtl = await fs.readdir(spillDir);
      assert.equal(afterTtl.includes(expiredName), false);
      assert.equal(afterTtl.includes(freshName), true);
      assert.equal(afterTtl.includes(path.basename(res1.filePath)), true);
      assert.equal(afterTtl.includes(unrelatedTxt), true);
      assert.equal(afterTtl.includes(unrelatedLog), true);

      // Verify passing a future nowMs still protects the freshly written file itself
      const futureRes = await writeSpillFile({
        tool: "run_checks",
        sections: [{ label: "future", content: "keep me", truncated: true }],
        env,
        nowMs: nowMs + SPILL_TTL_MS + 120_000,
      });
      assert.ok(futureRes);
      assert.equal(await fs.readFile(futureRes.filePath, "utf8"), "=== future ===\nkeep me");

      // Now seed 55 matching files with staggered mtimes (oldest idx 0..54 newest)
      const existingLogs = (await fs.readdir(spillDir)).filter((f) => SPILL_FILENAME_REGEX.test(f));
      for (const f of existingLogs) {
        await fs.unlink(path.join(spillDir, f));
      }

      const seededNames: string[] = [];
      for (let i = 0; i < 55; i++) {
        const hex = i.toString(16).padStart(6, "0");
        const name = `batch_search-20261122-010000-${hex}.log`;
        const full = path.join(spillDir, name);
        await fs.writeFile(full, `file ${i}\n`, "utf8");
        const sec = (nowMs - (60 - i) * 1000) / 1000;
        await fs.utimes(full, sec, sec);
        seededNames.push(name);
      }

      const lruRes = await writeSpillFile({
        tool: "batch_search",
        sections: [{ label: "Query 1", content: "newest", truncated: true }],
        env,
        nowMs,
      });
      assert.ok(lruRes);

      const remaining = await fs.readdir(spillDir);
      const remainingMatching = remaining.filter((f) => SPILL_FILENAME_REGEX.test(f));
      assert.equal(remainingMatching.length, SPILL_MAX_FILES);
      assert.equal(remainingMatching.includes(path.basename(lruRes.filePath)), true);
      // Oldest 6 (0..5) must have been evicted; newest 49 (6..54) kept
      for (let i = 0; i < 6; i++) {
        assert.equal(remainingMatching.includes(seededNames[i]!), false, `Expected ${seededNames[i]} evicted`);
      }
      for (let i = 6; i < 55; i++) {
        assert.equal(remainingMatching.includes(seededNames[i]!), true, `Expected ${seededNames[i]} kept`);
      }
      // Unrelated files untouched
      assert.equal(remaining.includes(unrelatedTxt), true);
      assert.equal(remaining.includes(unrelatedLog), true);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("fails open returning null when spillDir is a symlink, non-directory, or unwritable path", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-spill-sec-"));
    try {
      // 1. Symlinked/junction spillDir must be refused without writing through it
      const symlinkCache = path.join(tmpRoot, "sym-cache");
      const victimDir = path.join(tmpRoot, "victim");
      await fs.mkdir(symlinkCache, { recursive: true });
      await fs.mkdir(victimDir, { recursive: true });
      await fs.symlink(
        victimDir,
        path.join(symlinkCache, "spill"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const symRes = await writeSpillFile({
        tool: "run_checks",
        sections: [{ label: "x", content: "secret", truncated: true }],
        env: { AGY_FAST_CACHE_DIR: symlinkCache },
      });
      assert.equal(symRes, null);
      assert.deepEqual(await fs.readdir(victimDir), []);

      // 1b. Symlinked/junction parent cacheDir must also be refused (both before and after victim/spill exists)
      const parentVictimDir = path.join(tmpRoot, "parent-victim");
      const symParentCache = path.join(tmpRoot, "sym-parent-cache");
      await fs.mkdir(parentVictimDir, { recursive: true });
      await fs.symlink(
        parentVictimDir,
        symParentCache,
        process.platform === "win32" ? "junction" : "dir",
      );
      const symParentRes1 = await writeSpillFile({
        tool: "run_checks",
        sections: [{ label: "x", content: "secret", truncated: true }],
        env: { AGY_FAST_CACHE_DIR: symParentCache },
      });
      assert.equal(symParentRes1, null);
      assert.deepEqual(await fs.readdir(parentVictimDir), []);

      const victimSubSpill = path.join(parentVictimDir, "spill");
      await fs.mkdir(victimSubSpill, { recursive: true });
      const symParentRes2 = await writeSpillFile({
        tool: "run_checks",
        sections: [{ label: "x", content: "secret", truncated: true }],
        env: { AGY_FAST_CACHE_DIR: symParentCache },
      });
      assert.equal(symParentRes2, null);
      assert.deepEqual(await fs.readdir(victimSubSpill), []);

      // 2. spillDir is an existing regular file -> fail open
      const fileSpillCache = path.join(tmpRoot, "file-spill-cache");
      await fs.mkdir(fileSpillCache, { recursive: true });
      await fs.writeFile(path.join(fileSpillCache, "spill"), "not a dir", "utf8");
      const fileSpillRes = await writeSpillFile({
        tool: "run_checks",
        sections: [{ label: "x", content: "hello", truncated: true }],
        env: { AGY_FAST_CACHE_DIR: fileSpillCache },
      });
      assert.equal(fileSpillRes, null);

      // 3. Invalid cache dir path (parent is a regular file) -> fail open
      const blockerFile = path.join(tmpRoot, "blocker-file");
      await fs.writeFile(blockerFile, "nope", "utf8");
      const invalidPathRes = await writeSpillFile({
        tool: "run_checks",
        sections: [{ label: "x", content: "hello", truncated: true }],
        env: { AGY_FAST_CACHE_DIR: path.join(blockerFile, "nested") },
      });
      assert.equal(invalidPathRes, null);

      // 4. Read-only directory on POSIX -> fail open
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        const roCache = path.join(tmpRoot, "ro-cache");
        await fs.mkdir(roCache, { recursive: true });
        await fs.chmod(roCache, 0o555);
        try {
          const roRes = await writeSpillFile({
            tool: "run_checks",
            sections: [{ label: "x", content: "hello", truncated: true }],
            env: { AGY_FAST_CACHE_DIR: roCache },
          });
          assert.equal(roRes, null);
        } finally {
          await fs.chmod(roCache, 0o755);
        }
      }
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("formats compact spill footers with +N more, surrogate-safe label slicing, and strict caps", () => {
    const mockResult = {
      filePath: "/tmp/cache/spill/run_checks-20261122-000000-abcdef.log",
      totalLines: 400,
      totalBytes: 12000,
      capped: false,
      sections: [
        { label: "ok-task", startLine: 1, endLine: 20, truncated: false },
        { label: `very-long-label-name-${"🚀".repeat(12)}`, startLine: 22, endLine: 100, truncated: true },
        { label: "task-2", startLine: 102, endLine: 150, truncated: true },
        { label: "task-3", startLine: 152, endLine: 200, truncated: true },
        { label: "task-4", startLine: 202, endLine: 260, truncated: true },
        { label: "task-5", startLine: 262, endLine: 320, truncated: true },
        { label: "task-6", startLine: 322, endLine: 400, truncated: true },
      ],
    };

    const fullFooter = formatSpillFooter(mockResult);
    assert.ok(fullFooter.startsWith("\n[full output spilled: "));
    assert.match(fullFooter, /\+2 more\]$/);
    assert.doesNotMatch(fullFooter, /ok-task/);
    assert.equal(LONE_SURROGATE_RE.test(fullFooter), false);

    // Tight cap drops ranges gracefully while preserving intact filePath
    const tightFooter = formatSpillFooter(mockResult, { maxChars: 90, maxBytes: 90 });
    assert.ok(tightFooter.length <= 90);
    assert.ok(tightFooter.includes(mockResult.filePath));
    assert.doesNotMatch(tightFooter, /read_file ranges/);

    // Impossibly tiny cap returns empty string instead of corrupting filePath
    const impossible = formatSpillFooter(mockResult, { maxChars: 20, maxBytes: 20 });
    assert.equal(impossible, "");
  });
});
