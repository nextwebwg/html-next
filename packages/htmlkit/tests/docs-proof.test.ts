import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildDocsProof } from "../examples/docs/proof.js";

it("builds existing Markdown, heading links, generated reference data, and an authored live example in a consumer", async () => {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-docs-"));
  try {
    const result = await buildDocsProof(root, fileURLToPath(new URL("../../../docs/guide", import.meta.url)), "/proof/");
    expect(result.routes).toContain("/proof/guide/quick-start/");
    const guide = await readFile(join(result.outDir, "guide/quick-start/index.html"), "utf8");
    expect(guide).toContain('href="#');
    expect(guide).toContain("<pre>");
    expect(guide).toContain('href="/proof/guide/usage/"');
    expect(guide).toContain('href="https://nextwebwg.org/declarative-components/');
    const reference = await readFile(join(result.outDir, "reference/counter/index.html"), "utf8");
    expect(reference).toContain("Increment amount.");
    expect(reference).toContain('data-component="proof-counter"');
    expect(reference).toContain('href="/proof/guide/quick-start/"');
    expect(result.browserInputs.some(path => /(?:marked|\.server\.|proof\.ts)/.test(path))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
