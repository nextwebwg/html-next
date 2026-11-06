import assert from "node:assert/strict";
import { transform } from "esbuild";
import { describe, it, vi } from "vitest";
import { compileExpression } from "../src/expression.js";
import { parseTypeExpression, type TypeNode } from "../src/type-system.js";
import { expressionHelpersSource, Lowering, type Scope } from "../src/targets/vue-lowering.js";

const invalid = Symbol.for("html-next.invalid-result");
const draft = parseTypeExpression("object({ name: string, count: number, nested: object({ inner: object({ name: string }) }) })");
const rows = parseTypeExpression("list(object({ name: string }))");
const types = new Map<string, TypeNode>([["draft", draft], ["rows", rows], ["key", parseTypeExpression("string")], ["selector", parseTypeExpression("object({ key: string })")]]);
const scope: Scope & { references: ReadonlyMap<string, { type: TypeNode }> } = {
  code: new Map([...types.keys()].map(name => [name, `data.${name}`])),
  types: new Map([...types].map(([name, type]) => [name, { type, nullable: false }])),
  references: new Map([...types].map(([name, type]) => [name, { type }])),
};

async function compile(source: string, expressionScope: Scope = scope, setup = "", mode: "value" | "text" | "attribute" = "value", attributeName = "data-value") {
  const lowering = new Lowering();
  const ast = compileExpression(source).ast;
  const code = mode === "attribute" ? lowering.attribute(ast, expressionScope, attributeName) : lowering[mode](ast, expressionScope);
  const metadata = lowering.referenceDeclarations();
  const output = await transform(`${expressionHelpersSource()}\n${metadata.join("\n")}\nexport function run(data: any) { ${setup} return ${code}; }`, { loader: "ts", format: "cjs" });
  const module = { exports: {} as { run(data: object): unknown } };
  new Function("module", "exports", output.code)(module, module.exports);
  return module.exports.run;
}

const values = () => ({ draft: { name: 7, count: "bad", nested: 2 }, rows: [{ name: 7 }], key: "name", selector: { key: "name" } });

describe("shared framework actual-reference lowering", () => {
  for (const checked of [false, true]) for (const [source, expected] of [
    ["$draft.count = null", undefined], ["$draft.count != null", undefined],
    ["$draft.count = $draft.count", undefined], ["$draft.count != $draft.count", undefined],
    ["not ($draft.count = $draft.count)", true], ["default($draft.count = null, true)", true],
    ["($draft.count = null) = false", undefined],
  ] as const) {
    it(`propagates absent equality for ${source} (checked: ${checked})`, async () => {
      const local: Scope = checked ? scope : { ...scope, references: undefined,
        types: new Map([["draft", { type: parseTypeExpression("unknown"), nullable: true }]]) };
      assert.equal((await compile(source, local))({ draft: {} }), expected);
    });
  }
  it("preserves null and present numeric equality", async () => {
    const run = await compile("$draft.count = null");
    assert.equal(run({ draft: { count: null } }), true);
    assert.equal(run({ draft: { count: 1 } }), false);
    assert.equal((await compile("$draft.count = 1"))({ draft: { count: 1 } }), true);
  });
  it("reads both comparison operands once in order even when one is absent", async () => {
    const unknown = parseTypeExpression("unknown");
    const local: Scope = { code: new Map([["raw", "data.raw"]]), types: new Map([["raw", { type: unknown, nullable: true }]]) };
    const reads: string[] = [];
    const result = (await compile("$raw.left = $raw.right", local))({ raw: {
      get left() { reads.push("left"); return undefined; }, get right() { reads.push("right"); return 1; },
    } });
    assert.equal(result, undefined);
    assert.deepEqual(reads, ["left", "right"]);
  });
  for (const [source, expectedReads] of [["(1 / 0) + $draft.count", 1], ["($draft.count / 0) = $draft.count", 2]] as const) {
    it(`evaluates ordinary binary operands before propagating invalidity in ${source}`, async () => {
      let reads = 0;
      assert.equal((await compile(source))({ draft: { get count() { return ++reads; } } }), invalid);
      assert.equal(reads, expectedReads);
    });
  }
  for (const count of [undefined, null]) {
    it(`keeps an absent numeric field absent in arithmetic (${String(count)})`, async () => {
      assert.equal((await compile("$draft.count + 1"))({ draft: { count } }), undefined);
    });
  }

  for (const name of [undefined, null]) {
    it(`keeps an absent string field absent in prefix comparisons (${String(name)})`, async () => {
      assert.equal((await compile("$draft.name ^= 'A'"))({ draft: { name } }), undefined);
    });
  }

  it("treats an empty object as false even when its declaration has required fields", async () => {
    assert.equal((await compile("$draft ? 'yes' : 'no'"))({ draft: {} }), "no");
  });

  it("returns a boolean when a nullable boolean is the executed right operand", async () => {
    const boolean = parseTypeExpression("boolean");
    const local: Scope = { code: new Map([["yes", "data.yes"], ["flag", "data.flag"]]),
      types: new Map([["yes", { type: boolean, nullable: false }], ["flag", { type: boolean, nullable: true }]]),
      references: new Map([["yes", { type: boolean }], ["flag", { type: boolean }]]) };
    assert.equal((await compile("$yes and $flag", local))({ yes: true, flag: null }), false);
  });

  it("reads an unknown numeric accessor once during arithmetic", async () => {
    const unknown = parseTypeExpression("unknown");
    const local: Scope = { code: new Map([["raw", "data.raw"]]), types: new Map([["raw", { type: unknown, nullable: true }]]), references: new Map([["raw", { type: unknown }]]) };
    let reads = 0;
    const result = (await compile("$raw.value + 1", local))({ raw: { get value() { return ++reads; } } });
    assert.equal(result, 2);
    assert.equal(reads, 1);
  });

  for (const [source, value, expected] of [["-$raw.value", 1, -1], ["$raw.value ^= 'A'", "Ada", true]] as const) {
    it(`reads an unknown accessor once for ${source}`, async () => {
      const unknown = parseTypeExpression("unknown");
      const local: Scope = { code: new Map([["raw", "data.raw"]]), types: new Map([["raw", { type: unknown, nullable: true }]]), references: new Map([["raw", { type: unknown }]]) };
      let reads = 0;
      assert.equal((await compile(source, local))({ raw: { get value() { reads += 1; return value; } } }), expected);
      assert.equal(reads, 1);
    });
  }

  it("keeps an authored left name visible while propagating an invalid right operand", async () => {
    const unknown = parseTypeExpression("unknown");
    const local: Scope = { code: new Map([["left", "left"]]), types: new Map([["left", { type: unknown, nullable: true }]]), references: new Map([["left", { type: unknown }]]) };
    assert.equal((await compile("$left + 1 / 0", local, "const left = data.left;"))({ left: 2 }), invalid);
  });

  it("keeps an authored value name visible inside an object expression", async () => {
    const string = parseTypeExpression("string");
    const local: Scope = { code: new Map([["value", "value"]]), types: new Map([["value", { type: string, nullable: false }]]), references: new Map([["value", { type: string }]]) };
    assert.deepEqual((await compile("{ copy: $value }", local, "const value = data.value;"))({ value: "A" }), { copy: "A" });
  });

  for (const [name, source, expected] of [["left", "$left and true", true], ["right", "true and $right", true], ["operand", "not $operand", false], ["value", "$value and true", true]] as const) {
    it(`keeps the authored ${name} name visible in ${source}`, async () => {
      const boolean = parseTypeExpression("boolean");
      const local: Scope = { code: new Map([[name, name]]), types: new Map([[name, { type: boolean, nullable: true }]]), references: new Map([[name, { type: boolean }]]) };
      assert.equal((await compile(source, local, `const ${name} = data.value;`))({ value: true }), expected);
    });
  }

  for (const mode of ["text", "attribute"] as const) {
    it(`keeps the authored value name visible during list ${mode} serialization`, async () => {
      const list = parseTypeExpression("list(string)");
      const local: Scope = { code: new Map([["value", "value"]]), types: new Map([["value", { type: list, nullable: true }]]), references: new Map([["value", { type: list }]]) };
      assert.equal((await compile("$value", local, "const value = data.value;", mode))({ value: ["A", "B"] }), "A B");
    });

    it(`preserves an invalid object expression through ${mode} serialization`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try { assert.equal((await compile("{ name: $draft.name }", scope, "", mode))({ draft: { name: 7 } }), invalid); }
      finally { warn.mockRestore(); }
    });
  }

  it("preserves an invalid boolean through ordinary attribute serialization", async () => {
    const record = parseTypeExpression("object({ flag: boolean })");
    const local: Scope = { code: new Map([["draft", "data.draft"]]), types: new Map([["draft", { type: record, nullable: false }]]), references: new Map([["draft", { type: record }]]) };
    const run = await compile("$draft.flag", local, "", "attribute");
    assert.equal(run({ draft: { flag: true } }), "");
    assert.equal(run({ draft: { flag: false } }), undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try { assert.equal(run({ draft: { flag: 7 } }), invalid); }
    finally { warn.mockRestore(); }
  });

  it("reads an unknown enumerated attribute accessor once", async () => {
    const unknown = parseTypeExpression("unknown");
    const local: Scope = { code: new Map([["raw", "data.raw"]]), types: new Map([["raw", { type: unknown, nullable: true }]]), references: new Map([["raw", { type: unknown }]]) };
    let reads = 0;
    assert.equal((await compile("$raw.value", local, "", "attribute", "draggable"))({ raw: { get value() { reads += 1; return false; } } }), "false");
    assert.equal(reads, 1);
  });

  for (const [source, mode, expected] of [["$raw.value + 1", "value", 2], ["-$raw.value", "value", -1], ["$raw.value ^= 'A'", "value", true], ["$raw.value", "attribute", "false"]] as const) {
    it(`reads an accessor once in ordinary initialization for ${source} (${mode})`, async () => {
      const unknown = parseTypeExpression("unknown");
      const local: Scope = { code: new Map([["raw", "data.raw"]]), types: new Map([["raw", { type: unknown, nullable: true }]]) };
      let reads = 0;
      const result = (await compile(source, local, "", mode, "draggable"))({ raw: { get value() { reads += 1; return mode === "attribute" ? false : source.includes("^=") ? "Ada" : 1; } } });
      assert.equal(result, expected);
      assert.equal(reads, 1);
    });
  }

  for (const [source, expected] of [
    ["false ? $draft.name : 'OK'", "OK"], ["false and $draft.name", false], ["true or $draft.name", true],
    ["default('present', $draft.name)", "present"], ["$draft[$key]", invalid], ["$rows[0].name", invalid],
    ["default($draft[$key], 'fallback')", invalid], ["default($draft.nested.inner.name, 'missing')", "missing"],
    ["$draft.name = 7", invalid], ["-$draft.count", invalid], ["abs($draft.count)", invalid],
    ["concat('x', $draft.name)", invalid], ["{ name: $draft.name }", invalid], ["[$draft.name]", invalid],
  ] as const) {
    it(`preserves executed-reference semantics for ${source}`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try { assert.equal(await (await compile(source))(values()), expected); }
      finally { warn.mockRestore(); }
    });
  }

  it("checks the field selected by an actual key without rereading accessors", async () => {
    const run = await compile("$draft[$selector.key]");
    let names = 0, keys = 0;
    const data = { draft: { get name() { names += 1; return "Once"; }, count: 2 }, selector: { get key() { keys += 1; return "name"; } } };
    assert.equal(run(data), "Once");
    assert.deepEqual({ names, keys }, { names: 1, keys: 1 });
    assert.equal(run({ draft: { name: "Other", count: 2 }, selector: { key: "count" } }), 2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try { assert.equal(run({ draft: { name: "Other", count: "wrong" }, selector: { key: "count" } }), invalid); }
    finally { warn.mockRestore(); }
  });

  for (const source of ["$value.item", "$value[$key]"]) {
    it(`reads the root, selector and selected field once in order for ${source}`, async () => {
      const text = parseTypeExpression("object({ item: string })");
      const number = parseTypeExpression("object({ item: number })");
      const selected: Scope = { code: new Map([["value", "data.value"], ["mode", "data.mode"], ["key", "data.key"]]),
        types: new Map([["value", { type: text, nullable: false }], ["key", { type: parseTypeExpression("string"), nullable: false }]]),
        references: new Map([["value", { type: text, select: { from: "mode", options: [{ value: "text", type: text }, { value: "number", type: number }] } }]]) };
      const run = await compile(source, selected);
      const order: string[] = []; let mode = "text";
      const data = {
        get value() { order.push("root"); mode = "number"; return { get item() { order.push("item"); return 42; } }; },
        get mode() { order.push("mode"); return mode; },
        get key() { order.push("key"); return "item"; },
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try { assert.equal(run(data), 42); }
      finally { warn.mockRestore(); }
      assert.deepEqual(order, source.includes("[$key]") ? ["root", "mode", "key", "item"] : ["root", "mode", "item"]);
    });
  }

  it("uses the native scalar format rules in generated predicates", async () => {
    const cases = [
      ["keyword", "size-2", "two words"], ["url", "https://example.test/", "/relative"], ["email", "a@b", "no-at"],
      ["date", "2024-02-29", "2023-02-29"], ["month", "2026-11", "2026-13"], ["week", "2026-W40", "2026-W54"],
      ["time", "13:45", "25:00"], ["datetime-local", "2026-11-05T13:45", "2026-11-05"],
      ["datetime", "2026-11-05T13:45Z", "2026-11-05T13:45"], ["color", "rebeccapurple", "not-a-color"],
      ["color-hex", "#663399cc", "#12"], ["length", "1rem", "4"], ["percentage", "25%", "25"], ["duration", "200ms", "later"],
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [name, good, bad] of cases) {
        const type = parseTypeExpression(name!);
        const local: Scope = { code: new Map([["value", "data.value"]]), types: new Map([["value", { type, nullable: false }]]), references: new Map([["value", { type }]]) };
        const run = await compile("$value", local);
        assert.equal(run({ value: good }), good, name);
        assert.equal(run({ value: bad }), invalid, name);
        assert.equal(run({ value: null }), null, name);
      }
    } finally { warn.mockRestore(); }
  });

  it("checks separated keywords without replacing the value being read", async () => {
    for (const [name, written] of [["keyword+", "one two"], ["keyword#", "one, two"]]) {
      const type = parseTypeExpression(name!);
      const local: Scope = { code: new Map([["value", "data.value"]]), types: new Map([["value", { type, nullable: false }]]), references: new Map([["value", { type }]]) };
      const run = await compile("$value", local);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        assert.equal(run({ value: written }), written);
        const list = ["one", "two"];
        assert.equal(run({ value: list }), list);
        for (const bad of [[], ["two words"], [7], "one,,two"]) assert.equal(run({ value: bad }), invalid);
      } finally { warn.mockRestore(); }
    }
  });
});
