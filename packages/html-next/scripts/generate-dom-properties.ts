import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

interface InterfaceInfo {
  readonly extends: readonly string[];
  readonly properties: ReadonlyMap<string, string>;
}

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const outputPath = join(root, "src/generated/dom-properties.ts");

function findLibDom(): { path: string; version: string } {
  const typescriptPackagePath = require.resolve("typescript/package.json");
  const typescriptRoot = dirname(typescriptPackagePath);
  const packageJson = require(typescriptPackagePath) as {
    version: string;
    optionalDependencies?: Record<string, string>;
  };
  const ordinaryPath = join(typescriptRoot, "lib/lib.dom.d.ts");
  if (existsSync(ordinaryPath)) return { path: ordinaryPath, version: packageJson.version };

  const platformSuffix = `-${process.platform}-${process.arch}`;
  const platformPackage = Object.keys(packageJson.optionalDependencies ?? {}).find((name) =>
    name.endsWith(platformSuffix),
  );
  if (platformPackage === undefined) {
    throw new Error(`Cannot find a TypeScript platform package for ${process.platform}-${process.arch}.`);
  }
  const platformRoot = dirname(require.resolve(`${platformPackage}/package.json`));
  const platformPath = join(platformRoot, "lib/lib.dom.d.ts");
  if (!existsSync(platformPath)) {
    throw new Error(`TypeScript DOM declarations were not found at ${platformPath}.`);
  }
  return { path: platformPath, version: packageJson.version };
}

function findClosingBrace(source: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return index;
  }
  throw new Error(`Unclosed interface body starting at offset ${open}.`);
}

function parseDeclarations(source: string): {
  interfaces: Map<string, InterfaceInfo>;
  tags: Map<string, string>;
} {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const interfaces = new Map<string, InterfaceInfo>();
  const tags = new Map<string, string>();
  const declaration = /\binterface\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+extends\s+([^{]+))?\s*{/g;

  for (let match = declaration.exec(withoutComments); match !== null; match = declaration.exec(withoutComments)) {
    const name = match[1]!;
    const open = declaration.lastIndex - 1;
    const close = findClosingBrace(withoutComments, open);
    const body = withoutComments.slice(open + 1, close);
    const inherited = (match[2] ?? "")
      .split(",")
      .map((item) => item.trim().replace(/<.*$/, ""))
      .filter(Boolean);

    if (name === "HTMLElementTagNameMap") {
      const tagEntry = /^\s*"([^"]+)"\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;/gm;
      for (let tagMatch = tagEntry.exec(body); tagMatch !== null; tagMatch = tagEntry.exec(body)) {
        tags.set(tagMatch[1]!, tagMatch[2]!);
      }
    }

    const own = new Map(interfaces.get(name)?.properties ?? []);
    const property = /^\s*(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/gm;
    for (let propertyMatch = property.exec(body); propertyMatch !== null; propertyMatch = property.exec(body)) {
      const exact = propertyMatch[1]!;
      own.set(exact.toLowerCase(), exact);
    }
    const previousExtends = interfaces.get(name)?.extends ?? [];
    interfaces.set(name, {
      extends: [...new Set([...previousExtends, ...inherited])],
      properties: own,
    });
    declaration.lastIndex = close + 1;
  }

  return { interfaces, tags };
}

function reachableInterfaces(
  interfaces: ReadonlyMap<string, InterfaceInfo>,
  tags: ReadonlyMap<string, string>,
): Set<string> {
  const reachable = new Set<string>();
  const visit = (name: string): void => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const parent of interfaces.get(name)?.extends ?? []) visit(parent);
  };
  for (const name of tags.values()) visit(name);
  return reachable;
}

function assertNoReachableCollisions(
  name: string,
  interfaces: ReadonlyMap<string, InterfaceInfo>,
  memo: Map<string, Map<string, string>>,
  stack = new Set<string>(),
): Map<string, string> {
  const cached = memo.get(name);
  if (cached !== undefined) return cached;
  if (stack.has(name)) throw new Error(`DOM interface inheritance cycle at ${name}.`);
  const nextStack = new Set(stack).add(name);
  const result = new Map<string, string>();
  const info = interfaces.get(name);
  if (info === undefined) return result;

  for (const parent of info.extends) {
    for (const [key, exact] of assertNoReachableCollisions(parent, interfaces, memo, nextStack)) {
      result.set(key, exact);
    }
  }
  for (const [key, exact] of info.properties) {
    const previous = result.get(key);
    if (previous !== undefined && previous !== exact) {
      throw new Error(`${name} exposes both ${previous} and ${exact} as lowercase key ${key}.`);
    }
    result.set(key, exact);
  }
  memo.set(name, result);
  return result;
}

function sortedRecord(entries: Iterable<readonly [string, string]>): Record<string, string> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

export async function generateDomProperties(): Promise<string> {
  const dom = findLibDom();
  const source = await readFile(dom.path, "utf8");
  const parsed = parseDeclarations(source);
  const reachable = reachableInterfaces(parsed.interfaces, parsed.tags);
  const collisionMemo = new Map<string, Map<string, string>>();
  for (const name of reachable) {
    assertNoReachableCollisions(name, parsed.interfaces, collisionMemo);
  }

  const interfaceData: Record<string, { extends: readonly string[]; properties: Record<string, string> }> = {};
  for (const name of [...reachable].sort()) {
    const info = parsed.interfaces.get(name);
    if (info === undefined) continue;
    interfaceData[name] = {
      extends: [...info.extends].sort(),
      properties: sortedRecord(info.properties),
    };
  }

  const header = [
    "// Generated by scripts/generate-dom-properties.ts.",
    "// Do not edit by hand.",
    `export const DOM_PROPERTY_DATA_VERSION = ${JSON.stringify(`typescript@${dom.version}`)};`,
    `export const DOM_TAG_INTERFACES: Readonly<Record<string, string>> = ${JSON.stringify(sortedRecord(parsed.tags), null, 2)};`,
    "export interface GeneratedDomInterface {",
    "  readonly extends: readonly string[];",
    "  readonly properties: Readonly<Record<string, string>>;",
    "}",
    `export const DOM_INTERFACES: Readonly<Record<string, GeneratedDomInterface>> = ${JSON.stringify(interfaceData, null, 2)};`,
    "",
  ];
  return `${header.join("\n")}\n`;
}

async function main(): Promise<void> {
  const generated = await generateDomProperties();
  if (process.argv.includes("--check")) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== generated) {
      throw new Error(`${relative(root, outputPath)} is stale; run npm run generate:dom.`);
    }
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
