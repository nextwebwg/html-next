import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";

import { parseComponent } from "../../html-next/src/source-parser.js";
import { evaluateCompiled, type CompiledExpression, type Value } from "../../html-next/src/expression.js";
import { typeCheck } from "../../html-next/src/type-system.js";
import type { TemplateNode } from "../../html-next/src/template.js";

// An inert benchmark adapter using the real parser, type checks, and expression evaluator.
// This is not the public Node worker/DOM renderer and cannot measure its hydration work.
const subjects = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as {
  name: string; rows: number; html: string; liquid: string; computed?: boolean;
}[];
const escape = (value: unknown, attribute = false) => String(value ?? "").replace(/[&<>"]/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': attribute ? "&quot;" : '"' })[character]!);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Render = (values: Map<string, Value>) => string;
const read = (plan: CompiledExpression | undefined, values: Map<string, Value>) => {
  if (!plan) throw new Error("Missing compiled benchmark expression");
  return evaluateCompiled(plan, values);
};

function compile(node: TemplateNode): Render {
  if (node.kind === "slot") throw new Error("Slots are outside this measured slice");
  if (node.kind === "text") {
    if (node.segments) { const segments = node.segments.map(compile); return values => segments.map(render => render(values)).join(""); }
    return node.expressionPlan ? values => escape(read(node.expressionPlan, values)) : () => escape(node.value);
  }
  const children = node.children.map(compile);
  const attributes = node.attributes.map(attribute => {
    if (attribute.kind === "literal") return () => ` ${attribute.name}="${escape(attribute.value, true)}"`;
    if (attribute.kind !== "attribute") throw new Error("Unsupported benchmark attribute");
    return (values: Map<string, Value>) => ` ${attribute.name}="${escape(read(attribute.expressionPlan, values), true)}"`;
  });
  const element: Render = values => `<${node.name}${attributes.map(render => render(values)).join("")}>${children.map(render => render(values)).join("")}</${node.name}>`;
  const flow = node.flow;
  if (!flow) return element;
  if (flow.kind === "if") return values => read(flow.testPlan, values) === true ? element(values) : "";
  if (flow.kind !== "each") throw new Error("Unsupported benchmark flow");
  return values => {
    const items = read(flow.listPlan, values);
    assert.ok(Array.isArray(items));
    let output = "";
    for (const item of items) { values.set(flow.item, item); output += element(values); }
    values.delete(flow.item);
    return output;
  };
}

for (const subject of subjects) {
  const start = performance.now();
  const definition = parseComponent(subject.html);
  const render = compile(definition.template);
  const props = Object.entries(definition.contract.props).map(([name, prop]) => [name, typeCheck(prop.type)] as const);
  const compileMs = performance.now() - start;
  const inputs: Record<string, Value> = subject.rows === 0 ? { title: "A & B <C>", visible: true } : {
    products: Array.from({ length: subject.rows }, (_, index) => ({ label: `Item ${index} & <value>`, price: index + 0.5, ...subject.computed ? { quantity: index % 2 * 2 + 1 } : {} })),
  };
  const execute = () => {
    const values = new Map<string, Value>();
    for (const [name, check] of props) {
      const value = inputs[name]!;
      const accepted = check(value, name, "value");
      if (!accepted.ok) throw new Error(`Invalid benchmark input ${name}`);
      values.set(name, accepted.value as Value);
    }
    return render(values);
  };
  const expected = subject.rows === 0 ? '<article title="A &amp; B &lt;C&gt;"><h2>A &amp; B &lt;C&gt;</h2></article>'
    : subject.computed ? `<ul>${Array.from({ length: subject.rows }, (_, index) => `<li>Item ${index} &amp; &lt;value&gt;: ${(index + 0.5) * (index % 2 * 2 + 1)}</li>`).join("")}</ul>`
    : `<ul>${Array.from({ length: subject.rows }, (_, index) => `<li><span>Item ${index} &amp; &lt;value&gt;</span><b>${index + 0.5}</b></li>`).join("")}</ul>`;
  assert.equal(execute(), expected);
  if (process.argv.includes("--validate")) {
    process.stdout.write(JSON.stringify({ name: subject.name, outputSha256: hash(expected), templateSha256: hash(subject.html), bytes: Buffer.byteLength(expected) }) + "\n");
    continue;
  }
  for (let index = 0; index < 1000; index++) execute();
  const iterations = Math.max(50, Math.floor(5000 / Math.max(1, subject.rows / 10)));
  const samples = [];
  let output = "";
  for (let sample = 0; sample < 9; sample++) {
    const before = performance.now();
    for (let index = 0; index < iterations; index++) output = execute();
    samples.push((performance.now() - before) * 1e6 / iterations);
  }
  assert.equal(output, expected);
  samples.sort((a, b) => a - b);
  process.stdout.write(JSON.stringify({
    name: subject.name, engine: "Node inert benchmark adapter", node: process.version, cpu: cpus()[0]?.model,
    compileMs, medianNs: samples[4], samplesNs: samples, iterations,
    bytes: Buffer.byteLength(expected), outputSha256: hash(expected), templateSha256: hash(subject.html), modelSha256: hash(JSON.stringify(inputs)),
    limitations: "Benchmark-only inert adapter; parser/type checks/expressions are production code. No Node worker, DOM, CSS, or hydration work. Node allocations not measured.",
  }) + "\n");
}
