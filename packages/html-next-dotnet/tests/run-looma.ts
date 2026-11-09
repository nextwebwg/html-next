import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const checkout = path.resolve(process.argv[2] ?? path.join(workspace, ".context/looma-pressure"));
const looma = path.join(checkout, "packages/looma");
const fixtureHost = path.join(workspace, "packages/html-next-dotnet/tests/HtmlNext.FixtureHost");
process.env.LOOMA_HTMLNEXT_ROOT = workspace;
process.env.LOOMA_TEST_TARGET = "html-next";
process.env.LOOMA_NATIVE_SERVER_MODULE = fileURLToPath(new URL("./looma-server.ts", import.meta.url));
execFileSync("corepack", ["pnpm", "build"], { cwd: workspace, stdio: "inherit" });
execFileSync("dotnet", ["build", fixtureHost, "-c", "Release", "--nologo"], { stdio: "inherit" });
const { prepareLibrary } = await import(pathToFileURL(path.join(looma, "tests/renderers/prepare-library.ts")).href);
const directory = await prepareLibrary();
let host: ReturnType<typeof spawn> | undefined;
let lines: ReturnType<typeof createInterface> | undefined;
try {
  const prepared = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  const { buildPreparationService } = await import(new URL("./looma-preparation-build.ts", import.meta.url).href);
  process.env.LOOMA_DOTNET_PREPARATION_SERVICE = await buildPreparationService(directory, prepared, looma);
  const request = path.join(directory, "native-catalog.json");
  await writeFile(request, JSON.stringify({
    sources: JSON.parse(await readFile(prepared.nativeSources, "utf8")),
    manifest: JSON.parse(await readFile(prepared.nativeAssets, "utf8")),
  }));
  host = spawn("dotnet", [path.join(fixtureHost, "bin/Release/net10.0/HtmlNext.FixtureHost.dll"), "--catalog-server", request], { stdio: ["ignore", "pipe", "inherit"] });
  lines = createInterface({ input: host.stdout! });
  const [ready] = await Promise.race([
    once(lines, "line"),
    once(host, "exit").then(([code, signal]) => { throw new Error(`Catalog host exited (${code ?? signal}).`); }),
  ]);
  const endpoint = JSON.parse(ready);
  if (endpoint.components !== prepared.components.length) throw new Error("The native host did not compile the complete prepared catalog.");
  process.env.LOOMA_DOTNET_ENDPOINT = ready;
  process.env.LOOMA_PREPARED_LIBRARY = directory;
  let rendered = 0;
  let preparations = 0;
  lines.on("line", line => { const value = JSON.parse(line); if (value.rendered) rendered++; if (value.prepared) preparations++; });
  console.log(`Native catalog ready: ${endpoint.components} retained components.`);
  const require = createRequire(path.join(looma, "package.json"));
  const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const test = spawn(process.execPath, [vitest, "run", "--project", "converted-source", "--maxWorkers=1", "--no-file-parallelism", ...process.argv.slice(3)], { cwd: looma, env: process.env, stdio: "inherit" });
  const [code] = await once(test, "exit");
  if (!rendered) throw new Error("No shared Looma scenes exercised the native catalog host.");
  console.log(`Rendered ${rendered} shared Looma scenes through C#.`);
  console.log(`Prepared ${preparations} authored module instances through the application service.`);
  process.exitCode = code ?? 1;
} finally {
  lines?.close();
  if (host?.pid && host.exitCode === null && host.signalCode === null) { host.kill(); await once(host, "exit"); }
  await rm(directory, { recursive: true, force: true });
}
