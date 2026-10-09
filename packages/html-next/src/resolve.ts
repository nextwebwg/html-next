import { fail } from "./diagnostics.js";

export interface ImportMapLike {
  readonly imports?: Readonly<Record<string, string>>;
}

export interface ResolvedResource {
  readonly url: string;
  /** URL prefix which relative component and controller entries may not escape. */
  readonly trustRoot: string;
  readonly mapping?: string;
}

export interface ComponentResourceResolver {
  resolveRoot(specifier: string): ResolvedResource;
  resolveDependency(specifier: string, parentURL: string, parentTrustRoot: string): ResolvedResource;
  assertFinalURL(resource: ResolvedResource, finalURL: string, source?: string): string;
}

const URL_LIKE = /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|\.\.?\/)/;

function directory(url: string): string {
  return new URL("./", url).href;
}

function originRoot(url: string): string {
  const parsed = new URL(url);
  return parsed.origin === "null" ? directory(url) : new URL("/", parsed).href;
}

function mappedTrustRoot(key: string, target: string): string {
  return key.endsWith("/") ? target : directory(target);
}

function within(url: string, root: string): boolean {
  return url === root || url.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Resolves HTML Next resource specifiers using an application-owned import map snapshot. */
export class ResourceResolver implements ComponentResourceResolver {
  readonly #baseURL: string;
  readonly #applicationOrigin: string;
  readonly #applicationTrustRoot: string;
  readonly #imports: ReadonlyMap<string, string>;

  constructor(map: ImportMapLike = {}, baseURL = "file:///", applicationURL = baseURL) {
    const base = new URL(baseURL);
    const application = new URL(applicationURL);
    this.#baseURL = base.href;
    this.#applicationOrigin = application.origin;
    this.#applicationTrustRoot = originRoot(application.href);
    this.#imports = importMapEntries(map, this.#baseURL);
  }

  resolveRoot(specifier: string): ResolvedResource {
    if (URL_LIKE.test(specifier)) {
      const url = new URL(specifier, this.#baseURL);
      if (url.origin !== this.#applicationOrigin) {
        fail(
          "HL010",
          `Cross-origin component root \`${url.href}\` requires an application-owned import-map entry.`,
          this.#baseURL,
        );
      }
      return Object.freeze({ url: url.href, trustRoot: this.#applicationTrustRoot });
    }
    return this.#resolveMapped(specifier);
  }

  resolveDependency(
    specifier: string,
    parentURL: string,
    parentTrustRoot: string,
  ): ResolvedResource {
    if (!URL_LIKE.test(specifier)) return this.#resolveMapped(specifier);
    const url = new URL(specifier, parentURL).href;
    if (!within(url, parentTrustRoot)) {
      fail("HL003", `Dependency \`${specifier}\` escapes approved root \`${parentTrustRoot}\`.`, parentURL);
    }
    return Object.freeze({ url, trustRoot: parentTrustRoot });
  }

  assertFinalURL(resource: ResolvedResource, finalURL: string, source = resource.url): string {
    const canonical = new URL(finalURL, resource.url).href;
    if (!within(canonical, resource.trustRoot)) {
      fail("HL004", `Final component URL \`${canonical}\` escapes approved root \`${resource.trustRoot}\`.`, source);
    }
    return canonical;
  }

  #resolveMapped(specifier: string): ResolvedResource {
    const resolved = resolveImportMap(this.#imports, specifier);
    if (resolved === undefined) {
      fail("HL002", `Bare resource specifier \`${specifier}\` is not mapped by the application.`);
    }
    return resolved;
  }
}

/** Absolute import-map entries resolved against a base URL. */
export function importMapEntries(map: ImportMapLike, baseURL: string): ReadonlyMap<string, string> {
  return new Map(Object.entries(map.imports ?? {}).map(([key, target]) => [key, new URL(target, baseURL).href]));
}

/** Import-map matching: an exact key, else the longest "/"-terminated prefix; undefined when unmapped. */
export function resolveImportMap(imports: ReadonlyMap<string, string>, specifier: string): ResolvedResource | undefined {
  const exact = imports.get(specifier);
  if (exact !== undefined) {
    return Object.freeze({ url: exact, trustRoot: mappedTrustRoot(specifier, exact), mapping: specifier });
  }
  const prefix = Array.from(imports.keys())
    .filter((key) => key.endsWith("/") && specifier.startsWith(key))
    .sort((left, right) => right.length - left.length)[0];
  if (prefix === undefined) return undefined;
  const target = imports.get(prefix)!;
  const url = new URL(specifier.slice(prefix.length), target).href;
  if (!within(url, target)) {
    fail("HL003", `Mapped resource \`${specifier}\` escapes approved root \`${target}\`.`);
  }
  return Object.freeze({ url, trustRoot: target, mapping: prefix });
}

export function isWithinTrustRoot(url: string, root: string): boolean {
  return within(new URL(url).href, new URL(root).href);
}
