import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "vitest";

import { parseComponent, parseTypeExpression, parseTypedValue, type TypeInput } from "@nextwebwg/html-next";
import { parseFragment } from "parse5";

import { cases } from "../../html-next/tests/conformance/cases.js";
import { convertComponents } from "../src/index.js";

const run = promisify(execFile);
const enabled = process.env.HTMLNEXT_TARGET_TEST === "1";
const nodeModulesPath = fileURLToPath(new URL("../node_modules", import.meta.url));

interface HtmlNode {
  readonly tagName?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly HtmlNode[];
  readonly sourceCodeLocation?: { readonly startOffset: number; readonly endOffset: number };
}

function scene(source: string): { readonly definition: string; readonly invocation: string } {
  const nodes = parseFragment(source, { sourceCodeLocationInfo: true }).childNodes as readonly HtmlNode[];
  const carriers = nodes.filter((node) => node.tagName === "template" && node.attrs?.some((attribute) => attribute.name === "component"));
  assert.equal(carriers.length, 1, "type parity requires one component definition per case");
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

describe.skipIf(!enabled)("public React converter type parity", () => {
  it("typechecks every successful conformance component and its typed props", async () => {
    const directory = await mkdtemp(join(tmpdir(), "html-next-react-types-"));
    try {
      await symlink(nodeModulesPath, join(directory, "node_modules"), "dir");
      const successful = cases.filter((testCase) => "probe" in testCase.expect);
      for (const [index, testCase] of successful.entries()) {
        const caseDirectory = join(directory, `case-${index}`);
        await mkdir(caseDirectory);
        const { definition, invocation } = scene(testCase.source);
        await writeFile(join(caseDirectory, "component.html"), definition);
        const outDirectory = join(caseDirectory, "out");
        const manifest = await convertComponents({ mode: "library", target: "react", entries: ["component.html"], root: caseDirectory, outDirectory });
        const component = manifest.components[0]!;
        const contract = parseComponent(definition, testCase.name).contract;
        const incoming = incomingProps(invocation, contract.tag, contract.props);
        assert.ok(incoming.length > 0, `${testCase.name} must invoke its component`);
        const checks = incoming.map((value, propIndex) => {
          const invalid = Object.entries(contract.props).some(([name, prop]) => {
            if (!Object.hasOwn(value, name)) return prop.required;
            const type = typeof prop.type === "string" ? parseTypeExpression(prop.type) : prop.type;
            return !parseTypedValue(value[name], type, "$", "value").ok ||
              prop.values !== undefined && !prop.values.includes(value[name] as never);
          });
          return `${invalid ? "// @ts-expect-error invalid HTML input must be rejected by React's public type\n" : ""}const props${propIndex} = ${JSON.stringify(value)} satisfies ComponentProps;\nvoid props${propIndex};`;
        });
        if (Object.hasOwn(contract.props, "n") && Object.hasOwn(contract.props, "flag") && Object.hasOwn(contract.props, "kind")) {
          checks.push("// @ts-expect-error numeric React props reject strings\nconst invalidNumber = { n: \"5\" } satisfies ComponentProps;\nvoid invalidNumber;");
          checks.push("// @ts-expect-error boolean React props reject strings\nconst invalidBoolean = { flag: \"false\" } satisfies ComponentProps;\nvoid invalidBoolean;");
          checks.push("// @ts-expect-error constrained keywords reject values outside the allowed set\nconst invalidKeyword = { kind: \"other\" } satisfies ComponentProps;\nvoid invalidKeyword;");
        }
        await writeFile(join(caseDirectory, "consumer.tsx"), `import type { ${component.name}Props as ComponentProps } from "./out/${component.artifact}";\n${checks.join("\n")}\n`);
      }
      const dependentDirectory = join(directory, "dependent");
      await mkdir(dependentDirectory);
      await writeFile(join(dependentDirectory, "component.html"), `<template component="x-dependent" status="early" summary="Selected prop types."><defs>
        <prop name="type" type="keyword" values="text, number" default="text">Mode.</prop>
        <prop name="value">Value.<type from="type"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
      </defs><input from:type="type" from:value="value"></template>`);
      await convertComponents({ mode: "library", target: "react", entries: ["component.html"], root: dependentDirectory,
        outDirectory: join(dependentDirectory, "out") });
      await writeFile(join(dependentDirectory, "consumer.tsx"), `import XDependent, { type XDependentProps } from "./out/react/XDependent";
const text = { type: "text", value: "hello" } satisfies XDependentProps;
const number = { type: "number", value: 2 } satisfies XDependentProps<"number">;
// @ts-expect-error numeric mode requires a number
const wrongNumber = { type: "number", value: "2" } satisfies XDependentProps<"number">;
// @ts-expect-error omitted mode defaults to text
const wrongDefault = { value: 2 } satisfies XDependentProps;
const jsxText = <XDependent type="text" value="hello" />;
const jsxNumber = <XDependent type="number" value={2} />;
// @ts-expect-error numeric JSX mode requires a number
const jsxWrongNumber = <XDependent type="number" value="2" />;
// @ts-expect-error default JSX mode requires text
const jsxWrongDefault = <XDependent value={2} />;
void [text, number, wrongNumber, wrongDefault, jsxText, jsxNumber, jsxWrongNumber, jsxWrongDefault];
`);
      await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: "Preserve", moduleResolution: "Bundler", jsx: "react-jsx", strict: true,
          skipLibCheck: true, allowImportingTsExtensions: true, lib: ["ES2022", "DOM", "DOM.Iterable"], noEmit: true,
        },
        include: ["case-*/consumer.tsx", "case-*/out/react/**/*.tsx", "case-*/out/react/**/*.ts",
          "dependent/consumer.tsx", "dependent/out/react/**/*.tsx", "dependent/out/react/**/*.ts"],
      }));
      try {
        await run(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "-p", join(directory, "tsconfig.json")], { cwd: directory });
      } catch (error) {
        const output = error as Error & { stdout?: string; stderr?: string };
        throw new Error(output.stdout || output.stderr || output.message, { cause: error });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
