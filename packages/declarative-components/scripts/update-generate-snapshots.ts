import { readFile, writeFile } from "node:fs/promises";

import { generateComponent } from "../src/generate.js";
import { parseComponent } from "../src/parser.js";

const fixture = new URL("../test/fixtures/x-button.html", import.meta.url);
const snapshot = new URL("../test/snapshots/x-button.json", import.meta.url);
const source = await readFile(fixture, "utf8");
const artifacts = generateComponent(parseComponent(source, "x-button.html"));
await writeFile(snapshot, `${JSON.stringify(artifacts, null, 2)}\n`, "utf8");
