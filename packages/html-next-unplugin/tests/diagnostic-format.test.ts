import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "vitest";

import { formatCheckDiagnostic } from "../src/index.js";

describe("compact check diagnostics", () => {
  it("links the location with OSC 8 and prints only the code, description, and location", () => {
    const source = pathToFileURL(resolve("card with spaces.html")).href;
    const output = formatCheckDiagnostic({ severity: "error", code: "HC013", message: "Invalid constraint.", source, line: 4, column: 7 });
    const uriPath = new URL(source).pathname;
    assert.equal(output, `error HC013  Invalid constraint.  ·  \x1b]8;;vscode://file${uriPath}:4:7\x1b\\card with spaces.html:4:7\x1b]8;;\x1b\\`);
    assert.equal(output.split("\n").length, 1);
  });

  it.runIf(process.platform === "win32")("preserves the server in Windows network file links", () => {
    const output = formatCheckDiagnostic({ severity: "error", code: "HC013", message: "Invalid constraint.",
      source: "file://server/share/card.html", line: 4, column: 7 }, { root: "\\\\server\\share" });
    assert.equal(output, "error HC013  Invalid constraint.  ·  \x1b]8;;vscode://file//server/share/card.html:4:7\x1b\\card.html:4:7\x1b]8;;\x1b\\");
  });

  it("supports plain output, missing locations, and converter messages without duplicate codes", () => {
    assert.equal(formatCheckDiagnostic({ severity: "error", code: "HTC001", source: "card.html", line: 2, column: 3,
      message: "card.html: HTC001: react conversion failed" }, { hyperlinks: false }),
    "error HTC001  react conversion failed  ·  card.html:2:3");
    assert.equal(formatCheckDiagnostic({ severity: "error", code: "HN004", message: "Duplicate entry." }),
      "error HN004  Duplicate entry.");
    assert.equal(formatCheckDiagnostic({ severity: "error", code: "HT001", source: "<source>", message: "Missing root." }),
      "error HT001  Missing root.  ·  <source>");
  });
});
