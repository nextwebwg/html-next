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

function mappedTrustRoot(key: string, target: string): string {
  return key.endsWith("/") ? target : directory(target);
}

function within(url: string, root: string): boolean {
  return url === root || url.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Resolves HTML Next resource specifiers using an application-owned import map snapshot. */
export class ResourceResolver implements ComponentResourceResolver {
  readonly #baseURL: string;
  readonly #imports: ReadonlyMap<string, string>;

  constructor(map: ImportMapLike = {}, baseURL = "file:///") {
    this.#baseURL = new URL(baseURL).href;
    this.#imports = new Map(
      Object.entries(map.imports ?? {}).map(([key, target]) => [
        key,
        new URL(target, this.#baseURL).href,
      ]),
    );
  }

  resolveRoot(specifier: string): ResolvedResource {
    if (URL_LIKE.test(specifier)) {
      const url = new URL(specifier, this.#baseURL).href;
      return Object.freeze({ url, trustRoot: directory(url) });
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
    const exact = this.#imports.get(specifier);
    if (exact !== undefined) {
      return Object.freeze({
        url: exact,
        trustRoot: mappedTrustRoot(specifier, exact),
        mapping: specifier,
      });
    }
    const prefix = [...this.#imports.keys()]
      .filter((key) => key.endsWith("/") && specifier.startsWith(key))
      .sort((left, right) => right.length - left.length)[0];
    if (prefix === undefined) {
      fail("HL002", `Bare resource specifier \`${specifier}\` is not mapped by the application.`);
    }
    const target = this.#imports.get(prefix)!;
    return Object.freeze({
      url: new URL(specifier.slice(prefix.length), target).href,
      trustRoot: target,
      mapping: prefix,
    });
  }
}

export function isWithinTrustRoot(url: string, root: string): boolean {
  return within(new URL(url).href, new URL(root).href);
}
