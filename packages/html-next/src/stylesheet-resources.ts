import { fail, HtmlDiagnosticError } from "./diagnostics.js";
import type { ComponentFetcher } from "./graph.js";
import type { ResolvedResource } from "./resolve.js";
import type { ComponentDefinition, ComponentStylesheet, StylesheetCondition } from "./template.js";

export interface StylesheetImport {
  readonly specifier: string;
  readonly conditions: StylesheetCondition;
}
export interface ParsedStylesheet {
  readonly css: string;
  readonly imports: readonly StylesheetEntry[];
}
export type StylesheetEntry = StylesheetImport | { readonly css: string; readonly index: number };

/** CSS strings and URLs share CSS escape syntax, including hexadecimal code points. */
export function decodeCSS(value: string): string {
  return value.replace(/\\(?:([\da-f]{1,6})\s?|\r\n|[\n\r\f]|(.))/gi, (_match, hex: string | undefined, escaped: string | undefined) => {
    if (hex === undefined) return escaped ?? "";
    const point = Number.parseInt(hex, 16);
    return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? "\uFFFD" : String.fromCodePoint(point);
  });
}

/** Tokenizes only strings, comments and url(); ordinary declaration text stays intact. */
export function rebaseStylesheetURLs(css: string, baseURL: string, assetURL: (url: string) => string = url => url): string {
  const functions: string[] = [];
  css = css.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|([\w-]+)\(|[()]/g, (match, name: string | undefined) => {
    if (name !== undefined) { functions.push(name.toLowerCase()); return match; }
    if (match === "(") functions.push("");
    else if (match === ")") functions.pop();
    else if ((match.startsWith('"') || match.startsWith("'")) && /^(?:-webkit-)?image-set$/.test(functions.at(-1) ?? "")) {
      return JSON.stringify(assetURL(new URL(decodeCSS(match.slice(1, -1)), baseURL).href));
    }
    return match;
  });
  return css.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\burl\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|([^)'"\s]*(?:\\[\s\S][^)'"\s]*)*))\s*\)/gi,
    (match, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      const value = double ?? single ?? bare;
      if (value === undefined) return match;
      const decoded = decodeCSS(value);
      if (/^(?:data:|blob:|#)/i.test(decoded) || decoded === "") return match;
      return `url(${JSON.stringify(assetURL(new URL(decoded, baseURL).href))})`;
    });
}

export interface StylesheetLoaderOptions {
  readonly parse: (css: string) => ParsedStylesheet;
  readonly fetch: ComponentFetcher;
  readonly resolve: (specifier: string, parent: ResolvedResource) => ResolvedResource | Promise<ResolvedResource>;
  readonly assertFinalURL: (resource: ResolvedResource, finalURL: string) => string;
  readonly assetURL?: (url: string) => string;
  readonly supports?: (condition: string) => boolean;
}

/** Caches source bytes, while retaining adoption and import context separately. */
export function createStylesheetLoader(options: StylesheetLoaderOptions): {
  readonly inputs: Set<string>;
  readonly prepare: (definition: ComponentDefinition, resource: ResolvedResource) => Promise<ComponentDefinition>;
} {
  const inputs = new Set<string>();
  const cache = new Map<string, Promise<{ resource: ResolvedResource; parsed: ParsedStylesheet }>>();
  const read = (resource: ResolvedResource): Promise<{ resource: ResolvedResource; parsed: ParsedStylesheet }> => {
    const cached = cache.get(resource.url);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      inputs.add(resource.url);
      const response = await options.fetch(resource.url);
      const finalURL = options.assertFinalURL(resource, response.url);
      inputs.add(finalURL);
      const canonical = cache.get(finalURL);
      if (finalURL !== resource.url && canonical !== undefined) return canonical;
      const loaded = { resource: { ...resource, url: finalURL }, parsed: options.parse(response.source) };
      // Flattening namespaces changes unprefixed selectors and generated scope anchors.
      // Diagnose this until delivery can preserve each stylesheet's namespace environment.
      if (/@namespace\b/i.test(loaded.parsed.css.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, ""))) {
        fail("HY004", "Shared component stylesheets with @namespace are not supported; use namespace-free shared CSS.", finalURL);
      }
      if (finalURL !== resource.url) cache.set(finalURL, Promise.resolve(loaded));
      return loaded;
    })();
    cache.set(resource.url, pending);
    return pending;
  };
  const prepare = async (definition: ComponentDefinition, resource: ResolvedResource): Promise<ComponentDefinition> => {
    if (!/@import\b|url\(|image-set\(/i.test(definition.css)) return definition;
    const parsed = options.parse(definition.css);
    const stylesheets: ComponentStylesheet[] = [];
    let occurrence = 0;
    const visit = async (edge: StylesheetEntry, parent: ResolvedResource, conditions: readonly StylesheetCondition[], active: ReadonlySet<string>): Promise<void> => {
      if ("css" in edge) {
        stylesheets.push(Object.freeze({ url: `${parent.url}#html-next-css-preamble-${edge.index}`, css: edge.css, conditions }));
        return;
      }
      try {
        if (edge.conditions.supports !== undefined && options.supports?.(edge.conditions.supports) === false) return;
        const requested = await options.resolve(edge.specifier, parent);
        if (active.has(requested.url)) return;
        const cached = await read(requested);
        // Cached bytes do not confer the earlier importer's authority on a later importer.
        const loaded = { ...cached, resource: { ...requested, url: options.assertFinalURL(requested, cached.resource.url) } };
        if (active.has(loaded.resource.url)) return;
        const next = new Set([...active, requested.url, loaded.resource.url]);
        let condition = edge.conditions;
        if (condition.layer === "") {
          const index = occurrence;
          occurrence += 1;
          let hash = 2166136261;
          for (const character of `${definition.source.file}\0${definition.contract.tag}\0${index}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
          condition = { ...condition, layer: `html-next-anonymous-${(hash >>> 0).toString(36)}` };
        }
        const context = [...conditions, condition];
        for (const child of loaded.parsed.imports) await visit(child, loaded.resource, context, next);
        stylesheets.push(Object.freeze({ url: loaded.resource.url,
          css: rebaseStylesheetURLs(loaded.parsed.css, loaded.resource.url, options.assetURL), conditions: Object.freeze(context) }));
      } catch (error) {
        if (error instanceof HtmlDiagnosticError) throw error;
        fail("HY004", `Stylesheet import \`${edge.specifier}\` in \`${parent.url}\` failed: ${error instanceof Error ? error.message : String(error)}.`, parent.url);
      }
    };
    for (const edge of parsed.imports) await visit(edge, resource, [], new Set());
    return Object.freeze({ ...definition, css: rebaseStylesheetURLs(parsed.css, resource.url, options.assetURL),
      ...(stylesheets.length === 0 ? {} : { stylesheets: Object.freeze(stylesheets) }) });
  };
  return { inputs, prepare };
}

export function wrapStylesheetConditions(css: string, conditions: readonly StylesheetCondition[]): string {
  for (const condition of conditions.toReversed()) {
    if (condition.layer !== undefined) css = `@layer${condition.layer === "" ? "" : ` ${condition.layer}`} {\n${css}\n}`;
    if (condition.media !== undefined && condition.media !== "") css = `@media ${condition.media} {\n${css}\n}`;
    if (condition.supports !== undefined) css = `@supports (${condition.supports}) {\n${css}\n}`;
  }
  return css;
}

export interface SharedStylesheet {
  readonly id: string;
  readonly stylesheet: ComponentStylesheet;
  readonly adopters: readonly ComponentDefinition[];
}

/** Share compatible cascade positions; a later occurrence gets its own scoped copy when needed. */
export function collectSharedStylesheets(definitions: readonly ComponentDefinition[]): readonly SharedStylesheet[] {
  const groups: Array<{ id: string; key: string; stylesheet: ComponentStylesheet; adopters: ComponentDefinition[]; boundary: number }> = [];
  const identity = (sheet: ComponentStylesheet): string => JSON.stringify([sheet.url, sheet.css,
    sheet.conditions.filter(condition => Object.keys(condition).length > 0)]);
  const effects: string[] = [];
  const globalEffects = (css: string): boolean => {
    const rules = css.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, "");
    return [...rules.matchAll(/@([-\w]+)/g)].some(match => !["media", "supports", "container", "scope", "starting-style"].includes(match[1]!.toLowerCase()));
  };
  for (const definition of definitions) {
    let cursor = 0;
    for (const stylesheet of definition.stylesheets ?? []) {
      const key = identity(stylesheet);
      let index = groups.findIndex((group, at) => at >= cursor && group.key === key &&
        (!globalEffects(stylesheet.css) || effects.slice(group.boundary).every(effect => effect === key)) &&
        definition.root?.kind !== "component" && group.adopters.every(owner => owner.root?.kind !== "component"));
      if (index === -1) {
        index = groups.length;
        groups.push({ id: `${stylesheet.url}#html-next-occurrence-${groups.filter(group => group.stylesheet.url === stylesheet.url).length}`,
          key, stylesheet, adopters: [], boundary: effects.length });
      }
      const group = groups[index]!;
      if (!group.adopters.includes(definition)) group.adopters.push(definition);
      cursor = index + 1;
      if (globalEffects(stylesheet.css) || stylesheet.conditions.some(condition => condition.layer !== undefined)) effects.push(key);
    }
    if (globalEffects(definition.css) || definition.root?.kind === "component") effects.push(`local:${definition.contract.tag}`);
  }
  return groups;
}
