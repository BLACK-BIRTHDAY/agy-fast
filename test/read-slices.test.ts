import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { extractSymbols, runReadSlices } from "../src/tools/read-slices.js";

describe("read_slices", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-slices-"));

    await fs.writeFile(
      path.join(tmpDir, "sample.ts"),
      [
        "export interface Config {",
        "  port: number;",
        "}",
        "",
        "export class Server {",
        "  start() {",
        "    return '{not a brace close}';",
        "  }",
        "",
        "  async stop(force: boolean): Promise<void> {",
        "    if (force) {",
        "      return;",
        "    }",
        "  }",
        "}",
        "",
        "export const createApp = (cfg: Config) => {",
        "  return new Server();",
        "};",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "sample.py"),
      [
        "class Worker:",
        "    def run(self):",
        "        return 42",
        "",
        "async def helper():",
        "    return True",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "sample.go"),
      [
        "package main",
        "",
        "type Engine struct {",
        "  Name string",
        "}",
        "",
        "func (e *Engine) Start() {",
        "  println(e.Name)",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "sample.rs"),
      [
        "pub struct Cache {",
        "  size: usize,",
        "}",
        "",
        "impl Cache {",
        "  pub fn new(size: usize) -> Self {",
        "    Self { size }",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Title",
        "Intro line.",
        "```bash",
        "# not a heading",
        "```",
        "## Usage",
        "Details here.",
      ].join("\n"),
      "utf8",
    );
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts accurate multi-language symbol outlines with line spans", async () => {
    const tsSyms = extractSymbols(
      "sample.ts",
      await fs.readFile(path.join(tmpDir, "sample.ts"), "utf8"),
    );
    assert.deepEqual(
      tsSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      [
        "interface:Config:1-3",
        "class:Server:5-15",
        "method:start:6-8",
        "method:stop:10-14",
        "function:createApp:17-19",
      ],
    );

    const pySyms = extractSymbols(
      "sample.py",
      await fs.readFile(path.join(tmpDir, "sample.py"), "utf8"),
    );
    assert.deepEqual(
      pySyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      [
        "class:Worker:1-3",
        "method:run:2-3",
        "function:helper:5-6",
      ],
    );

    const goSyms = extractSymbols(
      "sample.go",
      await fs.readFile(path.join(tmpDir, "sample.go"), "utf8"),
    );
    assert.equal(goSyms.length, 2);
    assert.equal(goSyms[0]?.name, "Engine");
    assert.equal(goSyms[1]?.kind, "method");

    const rsSyms = extractSymbols(
      "sample.rs",
      await fs.readFile(path.join(tmpDir, "sample.rs"), "utf8"),
    );
    assert.ok(rsSyms.some((s) => s.kind === "struct" && s.name === "Cache"));
    assert.ok(rsSyms.some((s) => s.kind === "fn" && s.name === "new"));

    const mdSyms = extractSymbols(
      "README.md",
      await fs.readFile(path.join(tmpDir, "README.md"), "utf8"),
    );
    assert.deepEqual(
      mdSyms.map((s) => s.name),
      ["Title", "Usage"],
    );
  });

  it("returns combined outlines and multi-range slices with clamping and bounds handling", async () => {
    const res = await runReadSlices({
      cwd: tmpDir,
      outlines: ["sample.ts", "sample.py"],
      slices: [
        {
          path: "sample.ts",
          ranges: [
            [1, 3],
            [17, 50], // clamped to EOF (19)
            [99, 120], // out of bounds
          ],
        },
        {
          path: "missing.ts",
          ranges: [[1, 5]],
        },
      ],
    });

    assert.equal(res.isError, false);
    assert.match(res.text, /## Outline: sample\.ts \(19 lines\)/);
    assert.match(res.text, /L5-L15 \[class\] Server/);
    assert.match(res.text, /--- L1-L3 \(of 19\) ---/);
    assert.match(res.text, /1: export interface Config \{/);
    assert.match(res.text, /--- L17-L19 \(of 19\) ---/);
    assert.match(res.text, /out of bounds; file has 19 lines/);
    assert.match(res.text, /## Slice: missing\.ts\nERROR:/);
  });

  it("rejects empty requests", async () => {
    const res = await runReadSlices({ cwd: tmpDir });
    assert.equal(res.isError, true);
  });

  it("handles regex/comment braces, multiline TS methods, Java/C functions, Python docstrings, and 4-space JSON", async () => {
    const tsComplex = [
      "export class Multi {",
      "  async send(",
      "    payload: string,",
      "  ): Promise<void> {",
      "    const re = /\\{not_a_brace\\}/;",
      "    /* { block comment brace }",
      "       another line { */",
      "    return;",
      "  }",
      "}",
      "",
      "export const build = (",
      "  a: number,",
      "  b: number,",
      ") => {",
      "  return a + b;",
      "};",
    ].join("\n");
    const tsSyms = extractSymbols("complex.ts", tsComplex);
    assert.deepEqual(
      tsSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      [
        "class:Multi:1-10",
        "method:send:2-9",
        "function:build:12-17",
      ],
    );

    const javaSyms = extractSymbols(
      "Service.java",
      [
        "public class Service {",
        "  public int add(int a, int b) {",
        "    return a + b;",
        "  }",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(
      javaSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["class:Service:1-5", "method:add:2-4"],
    );

    const cSyms = extractSymbols(
      "main.c",
      [
        "int main(int argc, char **argv) {",
        "  return 0;",
        "}",
        "static void helper(void) {",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(
      cSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["function:main:1-3", "function:helper:4-5"],
    );

    const pySyms = extractSymbols(
      "doc.py",
      [
        "def foo():",
        '    """',
        "Column 0 docstring line",
        '    """',
        "    return 1",
        "",
        "def bar():",
        "    return 2",
      ].join("\n"),
    );
    assert.deepEqual(
      pySyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["function:foo:1-5", "function:bar:7-8"],
    );

    const jsonSyms = extractSymbols(
      "pkg.json",
      [
        "{",
        '    "name": "demo",',
        '    "scripts": {',
        '        "test": "node --test"',
        "    }",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(
      jsonSyms.map((s) => `${s.kind}:${s.name}`),
      ["key:name", "key:scripts"],
    );
  });

  it("ends Python symbols after multi-line signatures and includes decorators", () => {
    const pySyms = extractSymbols(
      "model.py",
      [
        "class Model:",
        "    def __init__(",
        "        self,",
        "        size: int,",
        "    ) -> None:",
        "        self.size = size",
        "        self.table = {",
        "    'k': 1,",
        "        }",
        "",
        "    @property",
        "    @functools.lru_cache(",
        "        maxsize=8,",
        "    )",
        "    def area(self) -> int:",
        "        return self.size \\",
        "* 2",
        "",
        "# --- helpers ---",
        "",
        "def build(",
        "    size: int,",
        "):",
        "    return Model(size)",
      ].join("\n"),
    );
    assert.deepEqual(
      pySyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      [
        "class:Model:1-17",
        "method:__init__:2-9",
        "method:area:11-17",
        "function:build:21-24",
      ],
    );

    // Comment between stacked decorators still preserves the full decorator range
    const commentBetweenDecos = extractSymbols(
      "decos.py",
      [
        "@outer",
        "# keep outer decorator attached",
        "@inner",
        "def run():",
        '    """',
        "# not a trailing comment",
        '    """',
        "    return 1",
      ].join("\n"),
    );
    assert.deepEqual(
      commentBetweenDecos.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["function:run:1-8"],
    );

    // Backslash continuation inside a quoted string must not split the function or emit fake symbols
    const quotedBackslash = extractSymbols(
      "str_cont.py",
      [
        "def f():",
        '    s = "hello \\',
        'def fake(): pass" + (',
        "        1",
        "    )",
        "    return s",
        "",
        "def g():",
        "    return 2",
      ].join("\n"),
    );
    assert.deepEqual(
      quotedBackslash.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["function:f:1-6", "function:g:8-9"],
    );

    // Python 3.12+ PEP 701 f-strings (same-quote reuse, multiline expr, quote fill format spec)
    const pep701 = extractSymbols(
      "pep701.py",
      [
        "def first(s):",
        '    a = f"{s.split("(")[0]}"',
        '    b = f"{s:\'>10}"',
        '    c = f"a {(',
        "        1 + 2",
        '    )} b"',
        "    return a, b, c",
        "",
        "def second():",
        "    return 2",
      ].join("\n"),
    );
    assert.deepEqual(
      pep701.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["function:first:1-7", "function:second:9-10"],
    );

    // Mid-edit unclosed bracket recovers on subsequent def/class (including decorator)
    const midEdit = extractSymbols(
      "midedit.py",
      [
        "def editing():",
        "    x = compute(a, b",
        "",
        "@decorator",
        "def intact_after():",
        "    return 1",
      ].join("\n"),
    );
    assert.deepEqual(
      midEdit.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["function:editing:1-2", "function:intact_after:4-6"],
    );
  });

  it("extracts Vue SFC blocks, CSS structure, TS no-semi types, multiline object-param functions, and Fastify routes", () => {
    const vueSyms = extractSymbols(
      "App.vue",
      [
        '<script setup lang="ts">',
        "interface NavItem { label: string }",
        "function toggleMenu() {",
        "  return true",
        "}",
        "</script>",
        "",
        "<template>",
        "  <header class=\"top-bar\">",
        "    <template #slotA>nested</template>",
        "  </header>",
        ...Array.from({ length: 32 }, (_, i) => `  <div>row ${i}</div>`),
        "  <!-- Modal Section -->",
        "  <ConfirmModal />",
        "</template>",
        "",
        "<style scoped>",
        "/* Layout */",
        "@media (max-width: 768px) {",
        "  .top-bar { display: none; }",
        "}",
        "</style>",
      ].join("\n"),
    );
    assert.ok(vueSyms.some((s) => s.kind === "script" && s.startLine === 1 && s.endLine === 6));
    assert.ok(vueSyms.some((s) => s.kind === "function" && s.name === "toggleMenu" && s.startLine === 3));
    assert.ok(vueSyms.some((s) => s.kind === "template" && s.startLine === 8 && s.endLine === 46));
    assert.ok(vueSyms.some((s) => s.kind === "style" && s.startLine === 48 && s.endLine === 53));
    assert.ok(vueSyms.some((s) => s.kind === "@media" && s.startLine === 50));

    const cssSyms = extractSymbols(
      "base.css",
      [
        "/* === Design Tokens === */",
        ":root {",
        "  --accent: #111;",
        "}",
        '[data-theme="dark"] {',
        "  --accent: #fff;",
        "}",
        "@keyframes fadeIn {",
        "  from { opacity: 0; }",
        "  to { opacity: 1; }",
        "}",
        "@media (max-width: 900px) {",
        "  .grid { display: block; }",
        "}",
      ].join("\n"),
    );
    assert.ok(cssSyms.some((s) => s.kind === "section" && s.name === "Design Tokens"));
    assert.ok(cssSyms.some((s) => s.kind === "tokens" && s.name === ":root" && s.endLine === 4));
    assert.ok(cssSyms.some((s) => s.kind === "tokens" && s.name.includes("data-theme") && s.endLine === 7));
    assert.ok(cssSyms.some((s) => s.kind === "@keyframes" && s.name === "fadeIn"));
    assert.ok(cssSyms.some((s) => s.kind === "@media"));

    const tsNoSemiSyms = extractSymbols(
      "runtime.ts",
      [
        "export type RuntimeMode = 'simulation' | 'live'",
        "",
        "export interface EnvConfig {",
        "  dbPath: string",
        "}",
        "",
        "export async function startServer(",
        "  options: { port: number; host?: string },",
        "): Promise<{ ok: boolean }> {",
        ...Array.from({ length: 42 }, (_, i) => `  const line${i} = ${i}`),
        "  app.get('/api/health', async () => {",
        "    return { ok: true }",
        "  })",
        "  return { ok: true }",
        "}",
      ].join("\n"),
    );
    const modeSym = tsNoSemiSyms.find((s) => s.name === "RuntimeMode");
    const fnSym = tsNoSemiSyms.find((s) => s.name === "startServer");
    const routeSym = tsNoSemiSyms.find((s) => s.kind === "route" && s.name === "GET /api/health");
    assert.ok(modeSym && modeSym.startLine === 1 && modeSym.endLine === 1, `Bad type span: ${JSON.stringify(modeSym)}`);
    assert.ok(fnSym && fnSym.startLine === 7 && fnSym.endLine === 56, `Bad fn span: ${JSON.stringify(fnSym)}`);
    assert.ok(routeSym && routeSym.startLine === 52 && routeSym.endLine === 54, `Bad route: ${JSON.stringify(routeSym)}`);
  });

  it("supports up to 40 outlines with multi-file fairness and hard-caps explicit maxChars <= 8800 UTF-8 bytes", async () => {
    const manyDir = path.join(tmpDir, "many-outlines");
    await fs.mkdir(manyDir, { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < 24; i++) {
      const rel = `many-outlines/f${i}.ts`;
      paths.push(rel);
      const body =
        i === 0
          ? [
              "export class HugeStore {",
              ...Array.from({ length: 60 }, (_, m) => `  method${m}() { return ${m}; }`),
              "}",
              "export function tailHelper() { return 1; }",
            ].join("\n")
          : `export function fn${i}() { return ${i}; }\n`;
      await fs.writeFile(path.join(tmpDir, rel), body, "utf8");
    }

    const outlineRes = await runReadSlices({ cwd: tmpDir, outlines: paths });
    assert.equal(outlineRes.isError, false);
    assert.ok(Buffer.byteLength(outlineRes.text, "utf8") <= 8_800);
    // Water-filling returns unused budget from the 23 tiny sibling files to f0.ts,
    // preserving all 60 methods + depth-0 tailHelper + fn23 without premature cuts
    assert.match(outlineRes.text, /method0/);
    assert.match(outlineRes.text, /method59/);
    assert.match(outlineRes.text, /tailHelper/);
    assert.match(outlineRes.text, /fn23/);
    assert.doesNotMatch(outlineRes.text, /omitted/);

    const tooMany = await runReadSlices({
      cwd: tmpDir,
      outlines: Array.from({ length: 41 }, () => paths[0]!),
    });
    assert.equal(tooMany.isError, true);
    assert.match(tooMany.text, /max 40 outlines/);

    // Explicit maxChars: 42000 must still stay <= 8800 bytes and surface read_file tip
    const bigSliceFile = path.join(tmpDir, "big-slice.ts");
    await fs.writeFile(
      bigSliceFile,
      Array.from({ length: 300 }, (_, i) => `export const row_${i} = "${"中文测试".repeat(10)}";`).join("\n"),
      "utf8",
    );
    const capped = await runReadSlices({
      cwd: tmpDir,
      slices: [{ path: "big-slice.ts", ranges: [[1, 300]] }],
      maxChars: 42_000,
    });
    assert.equal(capped.isError, false);
    assert.ok(
      Buffer.byteLength(capped.text, "utf8") <= 8_800,
      `Expected <= 8800B, got ${Buffer.byteLength(capped.text, "utf8")}`,
    );
    assert.match(capped.text, /use parallel read_file/);

    // Outlining >20 dense files stays <= 8800 bytes and surfaces batch-size tip when over budget
    const denseDir = path.join(tmpDir, "dense-outlines");
    await fs.mkdir(denseDir, { recursive: true });
    const densePaths: string[] = [];
    for (let i = 0; i < 30; i++) {
      const rel = `dense-outlines/module_${String(i).padStart(2, "0")}.ts`;
      densePaths.push(rel);
      const body = Array.from(
        { length: 25 },
        (_, k) => `export function handler_${i}_${k}_veryLongSymbolNameForBudgetTest() { return ${k}; }`,
      ).join("\n");
      await fs.writeFile(path.join(tmpDir, rel), body, "utf8");
    }
    const denseRes = await runReadSlices({ cwd: tmpDir, outlines: densePaths });
    assert.equal(denseRes.isError, false);
    assert.ok(
      Buffer.byteLength(denseRes.text, "utf8") <= 8_800,
      `Expected <= 8800B, got ${Buffer.byteLength(denseRes.text, "utf8")}`,
    );
    assert.match(denseRes.text, /module_29\.ts/);
    assert.match(denseRes.text, /more top-level symbols in L\d+-L25 omitted; use batch_search or read_file/);
    assert.match(denseRes.text, /batch 10-20 files per call/);
  });

  it("extracts Godot GDScript (.gd) outlines across comments, triple strings, nested inner classes, multiline enums, and Windows BOM/CRLF", async () => {
    const gdLines = [
      "\uFEFF@tool",
      "class_name CharacterController extends CharacterBody2D",
      "## Base controller for playable characters.",
      "",
      "signal health_changed(current: int, maximum: int)",
      "signal combo_triggered(",
      "\tcombo_name: StringName,",
      "\thit_count: int,",
      ")",
      "",
      "enum MoveState { IDLE, RUN, AIR }",
      "",
      "enum DamageType {",
      "\tPHYSICAL = 0,",
      "\tMAGICAL = 1, # ignores { fake } braces in comment",
      "\tTRUE_DMG = 2,",
      "}",
      "",
      "enum {",
      "\tLAYER_WORLD = 1,",
      "\tLAYER_ACTOR = 2,",
      "}",
      "",
      'const SHADER_STUB := """',
      "class FakeShaderClass:",
      "\tfunc fake_func():",
      "\t\tpass",
      '"""',
      "",
      "const DOC_SINGLE := '''",
      "signal fake_signal",
      "enum FakeEnum { A, B }",
      "'''",
      "",
      "# func commented_out_func():",
      "# \tpass",
      "",
      "static func calc_mitigation(raw: float, armor: float) -> float:",
      "\treturn raw * (100.0 / (100.0 + armor))",
      "",
      "## Applies damage to this character.",
      '@rpc("any_peer", "call_local")',
      "func apply_damage(",
      "\tamount: int,",
      "\tkind: DamageType = DamageType.PHYSICAL,",
      ") -> void:",
      '\tvar note := """',
      "unindented multiline text inside function",
      '"""',
      "\tif amount > 0:",
      "\t\thealth_changed.emit(0, 100)",
      "",
      "class StateMachine:",
      "\tsignal state_entered(state_name: StringName)",
      "",
      "\tclass SubState:",
      "\t\tfunc tick(delta: float) -> void:",
      "\t\t\tpass",
      "",
      "\t## Transitions to target state.",
      "\tfunc transition_to(target: StringName) -> void:",
      "\t\tstate_entered.emit(target)",
    ];

    const gdContentCrlf = gdLines.join("\r\n");
    const gdSyms = extractSymbols("player.gd", gdContentCrlf);
    assert.deepEqual(
      gdSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}:d${s.depth}`),
      [
        "class_name:CharacterController:2-2:d0",
        "signal:health_changed:5-5:d0",
        "signal:combo_triggered:6-9:d0",
        "enum:MoveState:11-11:d0",
        "enum:DamageType:13-17:d0",
        "enum:<anonymous>:19-22:d0",
        "function:calc_mitigation:38-39:d0",
        "function:apply_damage:43-51:d0",
        "class:StateMachine:53-62:d0",
        "signal:state_entered:54-54:d1",
        "class:SubState:56-58:d1",
        "method:tick:57-58:d2",
        "method:transition_to:61-62:d1",
      ],
    );

    // Also verify BOM on line 1 inline `@tool class_name` + 4-space indentation + runReadSlices formatting
    const spaceGdPath = path.join(tmpDir, "inventory.gd");
    await fs.writeFile(
      spaceGdPath,
      [
        "\uFEFF@tool class_name Inventory",
        "class Slot:",
        "    static func empty() -> Slot:",
        "        return Slot.new()",
        "",
        '@rpc("authority") func sync_slots() -> void:',
        "    pass",
      ].join("\r\n"),
      "utf8",
    );

    const sliceRes = await runReadSlices({
      cwd: tmpDir,
      outlines: ["inventory.gd"],
    });
    assert.equal(sliceRes.isError, false);
    assert.match(sliceRes.text, /L1 \[class_name\] Inventory/);
    assert.match(sliceRes.text, /L2-L4 \[class\] Slot/);
    assert.match(sliceRes.text, /  L3-L4 \[method\] empty/);
    assert.match(sliceRes.text, /L6-L7 \[function\] sync_slots/);
  });

  it("circuit-breaks corrupted outlines/slices arguments cleanly without throwing", async () => {
    const badOutlines = await runReadSlices({
      cwd: tmpDir,
      outlines: [true, null] as unknown as string[],
    });
    assert.equal(badOutlines.isError, true);
    assert.match(badOutlines.text, /nested argument serialization corruption/i);
    assert.match(badOutlines.text, /outlines\[0\]: received boolean \(true\)/);

    const badSlices = await runReadSlices({
      cwd: tmpDir,
      slices: [false] as unknown as never[],
    });
    assert.equal(badSlices.isError, true);
    assert.match(badSlices.text, /slices\[0\]: received boolean \(false\)/);
    assert.match(badSlices.text, /read_file/);

    const stringified = await runReadSlices({
      cwd: tmpDir,
      outlines: JSON.stringify(["inventory.gd"]) as unknown as string[],
    });
    assert.equal(stringified.isError, false);
    assert.match(stringified.text, /L1 \[class_name\] Inventory/);
  });

  it("handles JSX tags, TS template literals, Python multiline signatures, Rust lifetimes, Shell ${#var}, Go raw strings, non-finite maxChars, and lone surrogates", async () => {
    // 1. TSX closing </Tag> and self-closing /> must not enter regex mode and leak brace depth
    const tsxClose = extractSymbols(
      "App.tsx",
      [
        "export function A({ xs }: { xs: string[] }) {",
        "  return <ul>{xs.map((x) => <li>{x}</li>)}</ul>;",
        "}",
        "export function B() { return <div />; }",
      ].join("\n"),
    );
    assert.deepEqual(
      tsxClose.map((s) => `${s.name}:${s.startLine}-${s.endLine}`),
      ["A:1-3", "B:4-4"],
    );

    const tsxSelfClose = extractSymbols(
      "Icon.tsx",
      [
        "export function A() {",
        "  return <div>{ok && <Icon s={1} />}</div>;",
        "}",
        "export function B() { return null; }",
      ].join("\n"),
    );
    assert.deepEqual(
      tsxSelfClose.map((s) => `${s.name}:${s.startLine}-${s.endLine}`),
      ["A:1-3", "B:4-4"],
    );

    // JS/TS regex literals starting with `>` (e.g. `/>/g`, `/>}/`) must still enter regex mode
    for (const fname of ["escape.ts", "escape.tsx"]) {
      const gtRegex = extractSymbols(
        fname,
        [
          "export function escapeHtml(s: string) {",
          '  return s.replace(/>/g, "&gt;").replace(/{/g, "&#123;");',
          "}",
          "export function closeBraceRegex(s: string) {",
          "  return />}/.test(s);",
          "}",
          "export function after() { return 1; }",
        ].join("\n"),
      );
      assert.deepEqual(
        gtRegex.map((s) => `${s.name}:${s.startLine}-${s.endLine}`),
        ["escapeHtml:1-3", "closeBraceRegex:4-6", "after:7-7"],
      );
    }

    // 2. TS multiline backtick template must not emit fake symbols or swallow real classes below
    const tplSyms = extractSymbols(
      "tpl.ts",
      ["const s = `", "export class Fake {", "`;", "export class Real {", "  m() {}", "}"].join("\n"),
    );
    assert.deepEqual(
      tplSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["class:Real:4-6", "method:m:5-5"],
    );

    // 3. Python multiline signatures & .pyi stubs
    const pyMulti = extractSymbols(
      "stub.pyi",
      ["def f(", "    a: int,", ") -> int:", "    return a"].join("\n"),
    );
    assert.deepEqual(
      pyMulti.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["function:f:1-4"],
    );

    // 4. Rust lifetimes, impl<T>, trait bounds, and block comments
    const rsSyms = extractSymbols(
      "lib.rs",
      [
        "/* pub fn commented_out() {} */",
        "pub struct View<'a> {",
        "  buf: &'a [u8],",
        "}",
        "impl<T> Cache<T> {",
        "  pub fn next<U: Clone + Send>() -> usize { 1 }",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(
      rsSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["struct:View<'a>:2-4", "impl:<T> Cache<T>:5-7", "fn:next<U: Clone + Send>:6-6"],
    );

    // 5. Shell parameter expansion with `#` inside `${...}`
    const shSyms = extractSymbols(
      "s.sh",
      ["f() {", "  local b=${1##*/}", "  local n=${#b}", '  echo "$b $n"', "}", "g() { :; }"].join("\n"),
    );
    assert.deepEqual(
      shSyms.map((s) => `${s.name}:${s.startLine}-${s.endLine}`),
      ["f:1-5", "g:6-6"],
    );

    // 6. Go raw backtick string ending in `\` & wrapped `interface{}` params & generic struct
    const goSyms = extractSymbols(
      "a.go",
      [
        "type Box[T any] struct {",
        "  Val T",
        "}",
        "func a() {",
        "  s := `dir\\`",
        "  _ = s",
        "}",
        "func c(",
        "  v interface{},",
        ") {",
        "  a()",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(
      goSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["struct:Box[T any]:1-3", "function:a:4-7", "function:c:8-12"],
    );

    // 7. Non-finite maxChars falls back cleanly instead of returning empty output, and single-line emoji truncation avoids lone surrogates
    const longEmoji = path.join(tmpDir, "long-emoji.md");
    await fs.writeFile(longEmoji, "a".repeat(938) + "🚀".repeat(50) + "\n", "utf8");
    const nanRes = await runReadSlices({
      cwd: tmpDir,
      outlines: ["sample.ts"],
      maxChars: "auto" as unknown as number,
    });
    assert.equal(nanRes.isError, false);
    assert.match(nanRes.text, /\[class\] Server/);

    const surrRes = await runReadSlices({
      cwd: tmpDir,
      slices: [{ path: "long-emoji.md", ranges: [[1, 1]] }],
      maxChars: 1000,
    });
    assert.equal(surrRes.isError, false);
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(surrRes.text),
      false,
      "read_slices output must not contain lone UTF-16 surrogates",
    );
  });

  it("extracts .html and .htm closed-range outlines with void tags, comments, container filtering, inline script/style recursion, and malformed recovery", async () => {
    const htmlDoc = [
      "<!DOCTYPE html>", // 1
      '<html lang="en">', // 2
      "  <head>", // 3
      '    <meta charset="utf-8">', // 4
      '    <link rel="stylesheet" href="/app.css">', // 5
      "    <style>", // 6
      "      /* === Theme Tokens === */", // 7
      "      :root {", // 8
      "        --accent: #09f;", // 9
      "      }", // 10
      "      @media (max-width: 768px) {", // 11
      "        body { font-size: 14px; }", // 12
      "      }", // 13
      "    </style>", // 14
      '    <script src="/vendor/bundle.js"></script>', // 15
      "  </head>", // 16
      "  <body>", // 17
      "    <!-- === Header === -->", // 18
      '    <header class="flex items-center px-4">', // 19
      '      <nav role="navigation" class="gap-2">', // 20
      '        <ul class="list-none flex">', // 21 (plain class -> excluded)
      '          <li><img src="/logo.png" alt="Logo"><br></li>', // 22
      "        </ul>", // 23
      "      </nav>", // 24
      "    </header>", // 25
      "    <!--", // 26
      '      <section id="commented-out">', // 27
      '        <div id="fake-inside-comment">ignored</div>', // 28
      "      </section>", // 29
      "    -->", // 30
      '    <!-- <div id="single-line-commented">nope</div> -->', // 31
      "    <!-- Sidebar -->", // 32
      '    <div class="tailwind-wrapper flex flex-col">', // 33 (plain class -> excluded)
      '      <div data-id="not-id" class="noise">', // 34 (data-id != id -> excluded)
      '        <div id="app" class="container">', // 35
      '          <div data-testid="toolbar" title="a > b && c < d" data-expr=\'x >= 1\'>', // 36
      '            <input type="text" name="q" />', // 37
      "          </div>", // 38
      "          <main>", // 39
      "            <section", // 40
      '              id="settings"', // 41
      '              class="p-6"', // 42
      "            >", // 43
      '              <form id="prefs-form">', // 44
      '                <fieldset data-testid="billing-fields">', // 45
      '                  <input type="checkbox" name="auto">', // 46
      "                </fieldset>", // 47
      "              </form>", // 48
      "            </section>", // 49
      "          </main>", // 50
      "        </div>", // 51
      "      </div>", // 52
      "    </div>", // 53
      '    <script type="module">', // 54
      "      function bootApp() {", // 55
      '        return "<div>not a tag</div>";', // 56
      "      }", // 57
      "      class Controller {", // 58
      "        init() {", // 59
      "          return bootApp();", // 60
      "        }", // 61
      "      }", // 62
      "    </script>", // 63
      "  </body>", // 64
      "</html>", // 65
    ].join("\n");

    const htmlSyms = extractSymbols("index.html", htmlDoc);
    const htmSyms = extractSymbols("legacy.htm", htmlDoc);
    assert.deepEqual(htmSyms, htmlSyms);

    // Every symbol stays within depth 0..2 and has valid closed range
    assert.ok(htmlSyms.every((s) => s.depth >= 0 && s.depth <= 2));
    assert.ok(htmlSyms.every((s) => s.endLine >= s.startLine));

    // Exact key blocks and labels
    assert.ok(htmlSyms.some((s) => s.kind === "block" && s.name === "<head>" && s.startLine === 3 && s.endLine === 16 && s.depth === 0));
    assert.ok(htmlSyms.some((s) => s.kind === "style" && s.name === "<style>" && s.startLine === 6 && s.endLine === 14 && s.depth === 1));
    assert.ok(htmlSyms.some((s) => s.kind === "section" && s.name === "Theme Tokens" && s.startLine === 7 && s.depth === 2));
    assert.ok(htmlSyms.some((s) => s.kind === "tokens" && s.name === ":root" && s.startLine === 8 && s.endLine === 10 && s.depth === 2));
    assert.ok(htmlSyms.some((s) => s.kind === "@media" && s.startLine === 11 && s.endLine === 13 && s.depth === 2));
    assert.ok(htmlSyms.some((s) => s.kind === "script" && s.name === '<script src="/vendor/bundle.js">' && s.startLine === 15 && s.endLine === 15 && s.depth === 1));
    assert.ok(htmlSyms.some((s) => s.kind === "block" && s.name === "<body>" && s.startLine === 17 && s.endLine === 64 && s.depth === 0));
    assert.ok(htmlSyms.some((s) => s.kind === "section" && s.name === "Header" && s.startLine === 18 && s.endLine === 18 && s.depth === 1));
    assert.ok(htmlSyms.some((s) => s.kind === "block" && s.name === "<header>" && s.startLine === 19 && s.endLine === 25 && s.depth === 1));
    assert.ok(htmlSyms.some((s) => s.kind === "block" && s.name === '<nav role="navigation">' && s.startLine === 20 && s.endLine === 24 && s.depth === 2));
    assert.ok(htmlSyms.some((s) => s.kind === "section" && s.name === "Sidebar" && s.startLine === 32 && s.endLine === 32 && s.depth === 1));
    // Wrapper plain-class divs and data-id div must NOT increment depth or appear
    assert.ok(htmlSyms.some((s) => s.kind === "block" && s.name === "<div #app>" && s.startLine === 35 && s.endLine === 51 && s.depth === 1));
    assert.ok(htmlSyms.some((s) => s.kind === "block" && s.name === '<div data-testid="toolbar">' && s.startLine === 36 && s.endLine === 38 && s.depth === 2));
    assert.ok(htmlSyms.some((s) => s.kind === "block" && s.name === "<section #settings>" && s.startLine === 40 && s.endLine === 49 && s.depth === 2));
    assert.ok(htmlSyms.some((s) => s.kind === "block" && s.name === "<form #prefs-form>" && s.startLine === 44 && s.endLine === 48 && s.depth === 2));
    assert.ok(htmlSyms.some((s) => s.kind === "block" && s.name === '<fieldset data-testid="billing-fields">' && s.startLine === 45 && s.endLine === 47 && s.depth === 2));
    // Inline script recursive JS symbols with exact line offsets
    assert.ok(htmlSyms.some((s) => s.kind === "script" && s.name === '<script type="module">' && s.startLine === 54 && s.endLine === 63 && s.depth === 1));
    assert.ok(htmlSyms.some((s) => s.kind === "function" && s.name === "bootApp" && s.startLine === 55 && s.endLine === 57 && s.depth === 2));
    assert.ok(htmlSyms.some((s) => s.kind === "class" && s.name === "Controller" && s.startLine === 58 && s.endLine === 62 && s.depth === 2));
    assert.ok(htmlSyms.some((s) => s.kind === "method" && s.name === "init" && s.startLine === 59 && s.endLine === 61 && s.depth === 2));

    // Exclusions: plain class containers, data-id, commented-out tags, external script contents
    assert.ok(!htmlSyms.some((s) => s.name.includes("tailwind-wrapper") || s.name.includes("list-none")));
    assert.ok(!htmlSyms.some((s) => s.name.includes("not-id")));
    assert.ok(!htmlSyms.some((s) => s.name.includes("commented-out") || s.name.includes("fake-inside-comment") || s.name.includes("single-line-commented")));

    // External <script src=...> with stray inner text must NOT recurse into JS
    const extScriptSyms = extractSymbols(
      "ext.html",
      ['<script src="app.js">', "function shouldNotBeParsed() { return 1; }", "</script>"].join("\n"),
    );
    assert.deepEqual(
      extScriptSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ['script:<script src="app.js">:1-3'],
    );

    // Single-line inline <script> and <style> preserve exact line numbers
    const oneLineInline = extractSymbols(
      "inline.html",
      [
        "<style>:root { --x: 1; }</style>",
        "<script>function quickRun() { return 1; }</script>",
      ].join("\n"),
    );
    assert.ok(oneLineInline.some((s) => s.kind === "tokens" && s.name === ":root" && s.startLine === 1 && s.endLine === 1));
    assert.ok(oneLineInline.some((s) => s.kind === "function" && s.name === "quickRun" && s.startLine === 2 && s.endLine === 2));

    // Resilient recovery for unclosed & mismatched tags
    const brokenHtml = [
      "<main>", // 1
      '  <section id="broken">', // 2
      '    <div id="unclosed-div">', // 3
      "      <p>unclosed paragraph", // 4
      "      </span>", // 5 (stray close tag)
      "  </section>", // 6 (unwinds unclosed-div to L5)
      '  <aside id="intact">', // 7
      "    <p>still works</p>", // 8
      "  </aside>", // 9
      '  <footer id="eof-open">', // 10 (unclosed at EOF -> L10-L11)
      "    <span>tail</span>", // 11
    ].join("\n");
    const brokenSyms = extractSymbols("broken.html", brokenHtml);
    assert.ok(brokenSyms.every((s) => s.endLine >= s.startLine));
    assert.deepEqual(
      brokenSyms.map((s) => `${s.name}:${s.startLine}-${s.endLine}:d${s.depth}`),
      [
        "<main>:1-11:d0",
        "<section #broken>:2-6:d1",
        "<div #unclosed-div>:3-5:d2",
        "<aside #intact>:7-9:d1",
        "<footer #eof-open>:10-11:d1",
      ],
    );
  });

  it("unifies Vue and Svelte template outlining with closed ranges, short/deeply-indented templates, and component landmarks", async () => {
    // Short Vue template (<30 lines) with >8-space indentation and >14 landmarks
    const shortVue = [
      '<script setup lang="ts">', // 1
      "function saveSettings() {", // 2
      "  return true;", // 3
      "}", // 4
      "</script>", // 5
      "<template>", // 6
      '  <div class="outer">', // 7 (plain class -> skipped)
      '    <div class="inner">', // 8
      '      <div class="deep">', // 9
      '          <section id="general" @click="count > 0 && saveSettings()">', // 10 (10 spaces!)
      "            <SettingsModal />", // 11 (12 spaces!)
      "            <NavDrawer>", // 12
      "              <ProfileTab />", // 13
      "            </NavDrawer>", // 14
      "            <DashboardView />", // 15
      "            <LoginPage />", // 16
      "            <CheckoutForm />", // 17
      "            <SidePanel />", // 18
      "            <AlertDialog />", // 19
      "            <PlainButton />", // 20 (NOT a landmark suffix -> excluded)
      "          </section>", // 21
      "      </div>", // 22
      "    </div>", // 23
      "  </div>", // 24
      "</template>", // 25
    ].join("\n");

    const vueSyms = extractSymbols("Settings.vue", shortVue);
    assert.ok(vueSyms.some((s) => s.kind === "template" && s.startLine === 6 && s.endLine === 25 && s.depth === 0));
    assert.ok(vueSyms.some((s) => s.kind === "block" && s.name === "<section #general>" && s.startLine === 10 && s.endLine === 21 && s.depth === 1));
    assert.ok(vueSyms.some((s) => s.kind === "component" && s.name === "<SettingsModal>" && s.startLine === 11 && s.endLine === 11 && s.depth === 2));
    assert.ok(vueSyms.some((s) => s.kind === "component" && s.name === "<NavDrawer>" && s.startLine === 12 && s.endLine === 14 && s.depth === 2));
    assert.ok(vueSyms.some((s) => s.kind === "component" && s.name === "<ProfileTab>" && s.startLine === 13 && s.endLine === 13 && s.depth === 2));
    assert.ok(vueSyms.some((s) => s.kind === "component" && s.name === "<DashboardView>" && s.startLine === 15));
    assert.ok(vueSyms.some((s) => s.kind === "component" && s.name === "<LoginPage>" && s.startLine === 16));
    assert.ok(vueSyms.some((s) => s.kind === "component" && s.name === "<CheckoutForm>" && s.startLine === 17));
    assert.ok(vueSyms.some((s) => s.kind === "component" && s.name === "<SidePanel>" && s.startLine === 18));
    assert.ok(vueSyms.some((s) => s.kind === "component" && s.name === "<AlertDialog>" && s.startLine === 19));
    assert.ok(!vueSyms.some((s) => s.name.includes("PlainButton")));
    assert.ok(vueSyms.every((s) => s.depth <= 2));

    // >14 landmarks inside a Vue template are ALL extracted (old 14-landmark cap removed)
    const manyVueLandmarks = [
      "<template>",
      ...Array.from({ length: 20 }, (_, i) => `  <section id="sec-${i}"><p>${i}</p></section>`),
      "</template>",
    ].join("\n");
    const manyVueSyms = extractSymbols("Many.vue", manyVueLandmarks);
    const secSyms = manyVueSyms.filter((s) => s.name.startsWith("<section #sec-"));
    assert.equal(secSyms.length, 20);
    assert.equal(secSyms[19]?.name, "<section #sec-19>");

    // Svelte without <template> wrapper (root markup + Svelte {a > b} expressions + script + style)
    const svelteRoot = [
      '<script lang="ts">', // 1
      "  export let count = 0;", // 2
      "  function increment() {", // 3
      "    count += 1;", // 4
      "  }", // 5
      "</script>", // 6
      "", // 7
      "<main>", // 8
      "  {#if count < 10}", // 9
      '    <section id="counter">', // 10
      "      <SettingsModal disabled={count > 5} />", // 11
      "    </section>", // 12
      "  {/if}", // 13
      "</main>", // 14
      "", // 15
      "<style>", // 16
      "  @media (max-width: 640px) {", // 17
      "    main { padding: 8px; }", // 18
      "  }", // 19
      "</style>", // 20
    ].join("\n");

    const svelteSyms = extractSymbols("Counter.svelte", svelteRoot);
    assert.ok(svelteSyms.some((s) => s.kind === "script" && s.startLine === 1 && s.endLine === 6 && s.depth === 0));
    assert.ok(svelteSyms.some((s) => s.kind === "function" && s.name === "increment" && s.startLine === 3 && s.endLine === 5 && s.depth === 1));
    assert.ok(svelteSyms.some((s) => s.kind === "block" && s.name === "<main>" && s.startLine === 8 && s.endLine === 14 && s.depth === 0));
    assert.ok(svelteSyms.some((s) => s.kind === "block" && s.name === "<section #counter>" && s.startLine === 10 && s.endLine === 12 && s.depth === 1));
    assert.ok(svelteSyms.some((s) => s.kind === "component" && s.name === "<SettingsModal>" && s.startLine === 11 && s.endLine === 11 && s.depth === 2));
    assert.ok(svelteSyms.some((s) => s.kind === "style" && s.startLine === 16 && s.endLine === 20 && s.depth === 0));
    assert.ok(svelteSyms.some((s) => s.kind === "@media" && s.startLine === 17 && s.endLine === 19 && s.depth === 1));

    // Svelte WITH <template> wrapper (<30 lines, >8-space indent)
    const svelteTpl = [
      "<template>",
      '          <section id="wrapped">',
      "            <UserDialog />",
      "          </section>",
      "</template>",
    ].join("\n");
    const svelteTplSyms = extractSymbols("Wrapped.svelte", svelteTpl);
    assert.deepEqual(
      svelteTplSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}:d${s.depth}`),
      [
        "template:<template>:1-5:d0",
        "block:<section #wrapped>:2-4:d1",
        "component:<UserDialog>:3-3:d2",
      ],
    );
  });

  it("water-fills unused budget from small outline files to preserve all trailing symbols of a large file", async () => {
    const wfDir = path.join(tmpDir, "waterfill-batch");
    await fs.mkdir(wfDir, { recursive: true });
    const paths: string[] = [];

    for (let i = 0; i < 8; i++) {
      const rel = `waterfill-batch/tiny_${i}.ts`;
      paths.push(rel);
      await fs.writeFile(
        path.join(tmpDir, rel),
        `export function tinyFn_${i}() { return ${i}; }\n`,
        "utf8",
      );
    }

    const largeRel = "waterfill-batch/large_module.ts";
    paths.push(largeRel);
    const largeBody = Array.from(
      { length: 45 },
      (_, i) => `export function moduleHandler_${String(i).padStart(2, "0")}() {\n  return ${i};\n}`,
    ).join("\n");
    await fs.writeFile(path.join(tmpDir, largeRel), largeBody, "utf8");

    // 9 files total: old static perFileSymbolLimit cut at 30 symbols, dropping moduleHandler_30..44.
    const res = await runReadSlices({ cwd: tmpDir, outlines: paths });
    assert.equal(res.isError, false);
    assert.ok(Buffer.byteLength(res.text, "utf8") <= 8_800);
    for (let i = 0; i < 8; i++) {
      assert.match(res.text, new RegExp(`tinyFn_${i}\\b`));
    }
    assert.match(res.text, /moduleHandler_00\b/);
    assert.match(res.text, /moduleHandler_30\b/);
    assert.match(res.text, /moduleHandler_44\b/);
    assert.doesNotMatch(res.text, /omitted/);

    // Piggybacked tiny slice + tiny outlines still returns unused budget to large outline
    const mixedRes = await runReadSlices({
      cwd: tmpDir,
      outlines: paths,
      slices: [{ path: "waterfill-batch/tiny_0.ts", ranges: [[1, 1]] }],
    });
    assert.equal(mixedRes.isError, false);
    assert.ok(Buffer.byteLength(mixedRes.text, "utf8") <= 8_800);
    assert.match(mixedRes.text, /moduleHandler_44\b/);
    assert.match(mixedRes.text, /## Slice: waterfill-batch\/tiny_0\.ts/);
  });

  it("packs overflowing outlines breadth-first by ascending depth (depth 0 -> depth 1 -> depth 2)", async () => {
    const bfDir = path.join(tmpDir, "breadth-first");
    await fs.mkdir(bfDir, { recursive: true });

    const classRel = "breadth-first/giant_class.ts";
    const classBody = [
      "export class GiantEngine {",
      ...Array.from(
        { length: 100 },
        (_, i) => `  method_${String(i).padStart(3, "0")}() { return ${i}; }`,
      ),
      "}",
      "export function trailingInit() { return 1; }",
      "export function trailingSync() { return 2; }",
      "export function trailingShutdown() { return 3; }",
    ].join("\n");
    await fs.writeFile(path.join(tmpDir, classRel), classBody, "utf8");

    const res = await runReadSlices({
      cwd: tmpDir,
      outlines: [classRel],
      maxChars: 1_200,
    });
    assert.equal(res.isError, false);
    assert.ok(res.text.length <= 1_200, `Expected <= 1200 chars, got ${res.text.length}`);
    assert.ok(Buffer.byteLength(res.text, "utf8") <= 8_800);
    // All depth-0 symbols (GiantEngine + all 3 trailing functions) must survive
    assert.match(res.text, /\[class\] GiantEngine/);
    assert.match(res.text, /\[function\] trailingInit/);
    assert.match(res.text, /\[function\] trailingSync/);
    assert.match(res.text, /\[function\] trailingShutdown/);
    // Early depth-1 methods backfill remaining budget and render before trailing depth-0 functions
    assert.match(res.text, /method_000\b/);
    assert.doesNotMatch(res.text, /method_099\b/);
    assert.ok(res.text.indexOf("method_000") < res.text.indexOf("trailingInit"));
    assert.match(res.text, /\n\.\.\. \(\+\d+ nested symbols omitted\)$/);

    // 3-level HTML breadth-first: depth 0 (<body>) + depth 1 (<header>, <main>, <footer>) survive before depth 2 children
    const htmlRel = "breadth-first/deep_page.html";
    const htmlBody = [
      "<body>",
      "  <header><p>top</p></header>",
      "  <main>",
      ...Array.from({ length: 80 }, (_, i) => `    <div id="row-${String(i).padStart(2, "0")}">x</div>`),
      "  </main>",
      "  <footer><p>bottom</p></footer>",
      "</body>",
    ].join("\n");
    await fs.writeFile(path.join(tmpDir, htmlRel), htmlBody, "utf8");

    const htmlRes = await runReadSlices({
      cwd: tmpDir,
      outlines: [htmlRel],
      maxChars: 1_100,
    });
    assert.equal(htmlRes.isError, false);
    assert.ok(htmlRes.text.length <= 1_100);
    assert.match(htmlRes.text, /<body>/);
    assert.match(htmlRes.text, /<header>/);
    assert.match(htmlRes.text, /<main>/);
    assert.match(htmlRes.text, /<footer>/);
    assert.match(htmlRes.text, /<div #row-00>/);
    assert.doesNotMatch(htmlRes.text, /<div #row-79>/);
    assert.ok(htmlRes.text.indexOf("<div #row-00>") < htmlRes.text.indexOf("<footer>"));
    assert.match(htmlRes.text, /\n\.\.\. \(\+\d+ nested symbols omitted\)$/);
  });

  it("emits exact uncovered L<min>-L<max> footer and enforces <= 8800 UTF-8 bytes when depth-0 symbols overflow (ASCII and CJK)", async () => {
    const giantDir = path.join(tmpDir, "giant-top");
    await fs.mkdir(giantDir, { recursive: true });

    // 1. ASCII giant file overflowing depth-0 (>8.5KB of top-level functions)
    const asciiRel = "giant-top/many_funcs.ts";
    const asciiLines: string[] = [];
    for (let i = 0; i < 300; i++) {
      asciiLines.push(`export function computePipelineStage_${String(i).padStart(3, "0")}() {`);
      asciiLines.push(`  return ${i};`);
      asciiLines.push("}");
    }
    await fs.writeFile(path.join(tmpDir, asciiRel), asciiLines.join("\n"), "utf8");

    const asciiRes = await runReadSlices({ cwd: tmpDir, outlines: [asciiRel] });
    assert.equal(asciiRes.isError, false);
    assert.ok(
      Buffer.byteLength(asciiRes.text, "utf8") <= 8_800,
      `Expected <= 8800B, got ${Buffer.byteLength(asciiRes.text, "utf8")}`,
    );
    const asciiMatch =
      /\n\.\.\. \(\+(\d+) more top-level symbols in L(\d+)-L(\d+) omitted; use batch_search or read_file\)$/.exec(
        asciiRes.text,
      );
    assert.ok(asciiMatch, `Expected top-level range footer, got:\n${asciiRes.text.slice(-300)}`);
    const omittedCount = Number(asciiMatch[1]);
    const minStart = Number(asciiMatch[2]);
    const maxEnd = Number(asciiMatch[3]);
    assert.ok(omittedCount > 0 && omittedCount < 300);
    // Exact uncovered line range: first omitted function starts at (300 - omittedCount)*3 + 1, last ends at 900
    assert.equal(minStart, (300 - omittedCount) * 3 + 1);
    assert.equal(maxEnd, 900);

    // 2. CJK giant file overflowing UTF-8 byte budget (3 bytes/CJK char)
    const cjkRel = "giant-top/cjk_spec.md";
    const cjkLines: string[] = [];
    for (let i = 0; i < 260; i++) {
      cjkLines.push(`# 第${String(i + 1).padStart(3, "0")}章_核心系统架构设计规范与接口说明`);
      cjkLines.push("正文内容。");
    }
    await fs.writeFile(path.join(tmpDir, cjkRel), cjkLines.join("\n"), "utf8");

    const cjkRes = await runReadSlices({
      cwd: tmpDir,
      outlines: [cjkRel],
      maxChars: 8_800,
    });
    assert.equal(cjkRes.isError, false);
    const cjkBytes = Buffer.byteLength(cjkRes.text, "utf8");
    assert.ok(cjkBytes <= 8_800, `Expected <= 8800 UTF-8 bytes, got ${cjkBytes}`);
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cjkRes.text),
      false,
      "CJK outline must not contain lone surrogates",
    );
    const cjkMatch =
      /\n\.\.\. \(\+(\d+) more top-level symbols in L(\d+)-L(\d+) omitted; use batch_search or read_file\)$/.exec(
        cjkRes.text,
      );
    assert.ok(cjkMatch, `Expected CJK top-level range footer, got:\n${cjkRes.text.slice(-300)}`);
    const cjkOmitted = Number(cjkMatch[1]);
    assert.equal(Number(cjkMatch[2]), (260 - cjkOmitted) * 2 + 1);
    assert.equal(Number(cjkMatch[3]), 520);
  });

  it("handles comment ReDoS inputs, unspaced '<' comparisons & apostrophes, astral emoji labels, compact <style>, and ##-only Markdown top-level overflow", async () => {
    // 1. P0-1: linear-time comment landmark trimming (no quadratic backtracking)
    const hugeComment = `<!-- a ${" ".repeat(50_000)} b -->\n<main><p>ok</p></main>`;
    const t0 = performance.now();
    const commentSyms = extractSymbols("redos.html", hugeComment);
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 200, `Expected linear-time parsing (<200ms), got ${elapsedMs.toFixed(1)}ms`);
    assert.deepEqual(
      commentSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["block:<main>:2-2"],
    );

    // 2. P1-2 Repro A: unspaced `<` comparison in Svelte {#if a<b && ok} must not swallow next tag
    const svelteCmp = [
      "<main>",
      "  {#if a<b && ok}",
      '    <section id="counter">',
      "      <SettingsModal />",
      "    </section>",
      "  {/if}",
      "</main>",
    ].join("\n");
    const cmpSyms = extractSymbols("Cmp.svelte", svelteCmp);
    assert.deepEqual(
      cmpSyms.map((s) => `${s.name}:${s.startLine}-${s.endLine}:d${s.depth}`),
      [
        "<main>:1-7:d0",
        "<section #counter>:3-5:d1",
        "<SettingsModal>:4-4:d2",
      ],
    );

    // 3. P1-2 Repro B: prose with unspaced `<` and apostrophe(s) must not drop subsequent landmarks
    const proseApos = [
      "<main>",
      "  <p>when a<b it's broken</p>",
      '  <section id="after"><p>it\'s ok</p></section>',
      "</main>",
    ].join("\n");
    const proseSyms = extractSymbols("prose.html", proseApos);
    assert.deepEqual(
      proseSyms.map((s) => `${s.name}:${s.startLine}-${s.endLine}:d${s.depth}`),
      [
        "<main>:1-4:d0",
        "<section #after>:3-3:d1",
      ],
    );

    // 4. P1-4: astral-plane emoji in id/data-testid/role/script attrs never produce lone UTF-16 surrogates
    const astral = "a" + "🚀".repeat(20);
    const emojiHtml = [
      `<div id="${astral}">id</div>`,
      `<div data-testid="${astral}">tid</div>`,
      `<nav role="${astral}">role</nav>`,
      `<script data-note="${astral}"></script>`,
    ].join("\n");
    const emojiSyms = extractSymbols("emoji.html", emojiHtml);
    assert.equal(emojiSyms.length, 4);
    for (const sym of emojiSyms) {
      assert.equal(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(sym.name),
        false,
        `Lone UTF-16 surrogate found in label: ${JSON.stringify(sym.name)}`,
      );
    }

    // 5. P2-2: inline <style> uses compact CSS mode (keeps :root/@media, omits arbitrary plain rules)
    const compactStyleHtml = [
      "<style>",
      "  .plain-card { padding: 8px; }",
      "  :root { --accent: #09f; }",
      "</style>",
    ].join("\n");
    const styleSyms = extractSymbols("style.html", compactStyleHtml);
    assert.deepEqual(
      styleSyms.map((s) => `${s.kind}:${s.name}`),
      ["style:<style>", "tokens::root"],
    );

    // 6. P2-1: ##-only Markdown (minDepth === 1) emits L<min>-L<max> top-level omission footer
    const h2OnlyRel = "giant-top/h2_only.md";
    const h2Lines: string[] = [];
    for (let i = 0; i < 80; i++) {
      h2Lines.push(`## Section_${String(i).padStart(2, "0")}_LongHeadingForBudgetTest`);
      h2Lines.push("Body paragraph.");
    }
    await fs.writeFile(path.join(tmpDir, h2OnlyRel), h2Lines.join("\n"), "utf8");
    const h2Res = await runReadSlices({
      cwd: tmpDir,
      outlines: [h2OnlyRel],
      maxChars: 1_200,
    });
    assert.equal(h2Res.isError, false);
    assert.ok(h2Res.text.length <= 1_200);
    const h2Match =
      /\n\.\.\. \(\+(\d+) more top-level symbols in L(\d+)-L(\d+) omitted; use batch_search or read_file\)$/.exec(
        h2Res.text,
      );
    assert.ok(h2Match, `Expected top-level range footer for ##-only doc, got:\n${h2Res.text.slice(-300)}`);
    const h2Omitted = Number(h2Match[1]);
    assert.equal(Number(h2Match[2]), (80 - h2Omitted) * 2 + 1);
    assert.equal(Number(h2Match[3]), 160);
  });
});
