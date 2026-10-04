import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { parseFragment } from "parse5";
import { HtmlDiagnosticError } from "@nextwebwg/html-next";
import { cases, type ConformanceCase, type DiagnosticExpect } from "../../html-next/tests/conformance/cases.js";
import { convertComponents } from "../src/index.js";

const invalid = cases.filter((testCase): testCase is ConformanceCase & { expect: DiagnosticExpect } => "code" in testCase.expect);
const staticCases = invalid.filter((testCase) => testCase.expect.code !== "HR001");
assert.equal(staticCases.length, 26, "Every shared invalid component case must remain accounted for");

for (const mode of ["application", "library"] as const) {
  describe(`Svelte ${mode} conversion diagnostics`, () => {
    for (const testCase of invalid) {
      it(testCase.name, async () => {
        const root = await mkdtemp(join(tmpdir(), "html-next-svelte-invalid-conversion-"));
        try {
          const definitions = parseFragment(testCase.source, { sourceCodeLocationInfo: true }).childNodes
            .filter((node) => "tagName" in node && node.tagName === "template" && node.attrs.some((attribute) => attribute.name === "component"))
            .map((node) => {
              const location = node.sourceCodeLocation;
              assert.ok(location);
              return testCase.source.slice(location.startOffset, location.endOffset);
            });
          assert.ok(definitions.length > 0);
          await writeFile(join(root, "invalid.html"), definitions.join("\n"));
          // Resource graphs report duplicate tags at their loader boundary, before rendering.
          const expected = testCase.expect.code === "HR001" ? "HL007" : testCase.expect.code;
          await assert.rejects(convertComponents({ mode, target: "svelte", root, entries: ["invalid.html"], outDirectory: join(root, "out") }),
            (error: unknown) => error instanceof HtmlDiagnosticError && error.diagnostic.code === expected);
        } finally { await rm(root, { recursive: true, force: true }); }
      });
    }
  });
}
