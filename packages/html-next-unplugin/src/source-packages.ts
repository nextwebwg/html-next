import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export async function packageDirectory(root: string, name: string): Promise<string | undefined> {
  let current = root;
  while (true) {
    const candidate = resolve(current, "node_modules", name);
    try { await stat(resolve(candidate, "package.json")); return await realpath(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Only explicitly opted-in packages and concrete export paths are converted. */
function sourceExports(exports: unknown): readonly [string, string][] {
  if (exports === null || typeof exports !== "object" || Array.isArray(exports)) return [];
  const record = exports as Record<string, unknown>;
  if (typeof record["html-next"] === "string") return [[".", record["html-next"]]];
  return Object.entries(record).flatMap(([subpath, value]) => {
    if ((subpath !== "." && !subpath.startsWith("./")) || subpath.includes("*")) return [];
    return sourceExports(value).map(([, source]) => [subpath, source] as [string, string]);
  });
}

export function assertPackageSource(source: string, packageRoot: string): void {
  const fromRoot = relative(packageRoot, source);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`HTML Next source import escapes its package: ${source}. Use a declared package dependency.`);
  }
}

export interface SourcePackage {
  readonly directory: string;
  readonly manifest: string;
  readonly exports: readonly { specifier: string; source: string }[];
}

export async function sourcePackages(root: string): Promise<SourcePackage[]> {
  const contents = await readFile(resolve(root, "package.json"), "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (contents === undefined) return [];
  const manifest = JSON.parse(contents) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const packages: SourcePackage[] = [];
  for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})])) {
    const directory = await packageDirectory(root, name);
    if (directory === undefined) continue;
    const path = resolve(directory, "package.json");
    const definition = JSON.parse(await readFile(path, "utf8")) as { exports?: unknown };
    const exports = sourceExports(definition.exports).map(([subpath, path]) => {
      if (!path.startsWith("./")) throw new Error(`HTML Next package exports must be relative: ${name} ${path}.`);
      const source = resolve(directory, path);
      assertPackageSource(source, directory);
      return { specifier: subpath === "." ? name : `${name}/${subpath.slice(2)}`, source };
    });
    if (exports.length > 0) packages.push({ directory, manifest: path, exports });
  }
  return packages;
}

/** A folder entry exports every component resource below it; symlinks are not followed. */
export async function componentSources(source: string, packageRoot: string): Promise<string[]> {
  assertPackageSource(await realpath(source), packageRoot);
  if (!(await stat(source)).isDirectory()) return extname(source) === ".html" ? [source] : [];
  const files: string[] = [];
  for (const item of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name === "node_modules") continue;
    const path = resolve(source, item.name);
    if (item.isDirectory()) files.push(...await componentSources(path, packageRoot));
    else if (item.isFile() && extname(item.name) === ".html") files.push(path);
  }
  return files;
}
