import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "vitest";

import { parseComponent, parseTypeExpression, parseTypedValue, type TypeInput } from "@nextwebwg/html-next";
import { parseFragment } from "parse5";

import { cases } from "../../html-next/tests/conformance/cases.js";
import { convertComponents } from "../src/index.js";

const run = promisify(execFile);
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = new URL("../node_modules", import.meta.url).pathname;

interface HtmlNode {
  readonly tagName?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly HtmlNode[];
  readonly sourceCodeLocation?: { readonly startOffset: number; readonly endOffset: number };
}

function scene(source: string): { readonly definition: string; readonly invocation: string } {
  const nodes = parseFragment(source, { sourceCodeLocationInfo: true }).childNodes as readonly HtmlNode[];
  const carriers = nodes.filter((node) => node.tagName === "template" && node.attrs?.some((attribute) => attribute.name === "component"));
  assert.equal(carriers.length, 1, "type parity currently requires one component definition per case");
  const carrier = carriers[0];
  assert.ok(carrier?.sourceCodeLocation);
  return {
    definition: source.slice(carrier.sourceCodeLocation.startOffset, carrier.sourceCodeLocation.endOffset),
    invocation: source.slice(carrier.sourceCodeLocation.endOffset),
  };
}

function incomingProps(invocation: string, tag: string, props: Readonly<Record<string, { readonly type: TypeInput }>>): readonly Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.tagName === tag) {
      const incoming: Record<string, unknown> = {};
      for (const attribute of node.attrs ?? []) {
        const name = Object.keys(props).find((prop) => prop.toLowerCase() === attribute.name);
        if (name === undefined) continue;
        const type = props[name]!.type;
        const parsed = parseTypedValue(attribute.value, typeof type === "string" ? parseTypeExpression(type) : type, "$", "html");
        incoming[name] = parsed.ok ? parsed.value : attribute.value;
      }
      found.push(incoming);
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  for (const node of parseFragment(invocation).childNodes as readonly HtmlNode[]) visit(node);
  return found;
}

describe.skipIf(!enabled)("public Vue converter type parity", () => {
  it("typechecks every successful conformance component and its typed props", async () => {
    const directory = await mkdtemp(join(tmpdir(), "html-next-vue-types-"));
    try {
      await symlink(nodeModulesPath, join(directory, "node_modules"), "dir");
      const successful = cases.filter((testCase) => "probe" in testCase.expect);
      for (const [index, testCase] of successful.entries()) {
        const caseDirectory = join(directory, `case-${index}`);
        await mkdir(caseDirectory);
        const { definition, invocation } = scene(testCase.source);
        await writeFile(join(caseDirectory, "component.html"), definition);
        const outDirectory = join(caseDirectory, "out");
        const manifest = await convertComponents({ mode: "library", target: "vue", entries: ["component.html"], root: caseDirectory, outDirectory });
        const component = manifest.components[0]!;
        const contract = parseComponent(definition, testCase.name).contract;
        const incoming = incomingProps(invocation, contract.tag, contract.props);
        assert.ok(incoming.length > 0, `${testCase.name} must invoke its component`);
        const checks = incoming.map((value, propIndex) => {
          const invalid = Object.entries(value).some(([name, item]) => {
            const prop = contract.props[name]!;
            const type = typeof prop.type === "string" ? parseTypeExpression(prop.type) : prop.type;
            return !parseTypedValue(item, type, "$", "value").ok || prop.values !== undefined && !prop.values.includes(item as never);
          });
          return `${invalid ? "// @ts-expect-error invalid HTML input must also be rejected by Vue's public type\n" : ""}const props${propIndex} = ${JSON.stringify(value)} satisfies InstanceType<typeof Component>["$props"];\nvoid props${propIndex};`;
        });
        if (Object.hasOwn(contract.props, "n") && Object.hasOwn(contract.props, "flag") && Object.hasOwn(contract.props, "kind")) {
          checks.push(`// @ts-expect-error numeric Vue props reject strings\nconst invalidNumber = { n: "5" } satisfies InstanceType<typeof Component>["$props"];\nvoid invalidNumber;`);
          checks.push(`// @ts-expect-error boolean Vue props reject strings\nconst invalidBoolean = { flag: "false" } satisfies InstanceType<typeof Component>["$props"];\nvoid invalidBoolean;`);
          checks.push(`// @ts-expect-error constrained keywords reject values outside the allowed set\nconst invalidKeyword = { kind: "other" } satisfies InstanceType<typeof Component>["$props"];\nvoid invalidKeyword;`);
        }
        await writeFile(join(caseDirectory, "consumer.ts"), `import Component from "./out/${component.artifact}";\n${checks.join("\n")}\n`);
      }
      await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
          skipLibCheck: true, lib: ["ES2022", "DOM", "DOM.Iterable"], noEmit: true,
        },
        include: ["case-*/consumer.ts", "case-*/out/vue/**/*.vue"],
      }));
      try {
        await run(join(nodeModulesPath, ".bin/vue-tsc"), ["-p", join(directory, "tsconfig.json"), "--noEmit"], { cwd: directory });
      } catch (error) {
        const output = error as Error & { stdout?: string; stderr?: string };
        throw new Error(output.stdout || output.stderr || output.message, { cause: error });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
