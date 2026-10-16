import { createHash } from "node:crypto";
import type { ComponentDefinition } from "@nextwebwg/html-next";
import { HtmlKitError } from "./config.js";
import type { ContentSecurityPolicyOptions, RenderedPolicy } from "./types.js";

/** Directives a `<meta http-equiv>` policy ignores (CSP 3, §3.3), which only the header carries. */
const headerOnly = new Set(["frame-ancestors", "report-uri", "sandbox"]);

/** The csp option checked: `false`, or sources per directive in CSP's own grammar. */
export function checkPolicyOptions(csp: unknown): ContentSecurityPolicyOptions | false {
  if (csp === undefined) return {};
  if (csp === false) return false;
  if (csp === null || typeof csp !== "object" || Array.isArray(csp)) throw new HtmlKitError("csp must be false or an object of sources per directive.");
  for (const [name, value] of Object.entries(csp)) {
    if (name === "reportOnly") {
      if (typeof value !== "boolean") throw new HtmlKitError("csp.reportOnly must be true or false.");
      continue;
    }
    if (!/^[a-z][a-z-]*$/.test(name)) throw new HtmlKitError(`csp directive ${name} must be a lowercase CSP directive name, such as "script-src".`);
    if (!Array.isArray(value) || !value.every(source => typeof source === "string" && /^[^\s;,]+$/.test(source))) {
      throw new HtmlKitError(`csp["${name}"] must be a list of CSP source expressions, such as ["https://cdn.example"], each without spaces, semicolons, or commas.`);
    }
  }
  return csp as ContentSecurityPolicyOptions;
}

/** A classic inline script's CSP hash source. */
export function scriptHash(script: string): string {
  return `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
}

/**
 * The site's policy, which every page carries: script-src with 'self' for HTMLKit's own modules and
 * controllers, the origin of each script any component of the site declares, and the hash of each
 * inline head script; object-src and base-uri 'none'; then the csp option's sources, added to each
 * directive. One policy keeps client navigation in place, since a document keeps the policy it loaded
 * with. Undefined with `csp: false`.
 */
export function sitePolicy(csp: ContentSecurityPolicyOptions | false, definitions: readonly ComponentDefinition[], scripts: readonly string[]): RenderedPolicy | undefined {
  if (csp === false) return undefined;
  const origins = new Set<string>();
  for (const definition of definitions) {
    for (const { src } of definition.scripts ?? []) {
      // A relative or root-relative script is HTMLKit's own origin; a bare one resolves through an import map.
      if (!/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/.test(src)) continue;
      const url = URL.parse(src, "https://htmlkit.invalid/");
      if (url !== null && /^https?:$/.test(url.protocol)) origins.add(url.origin);
    }
  }
  const directives = new Map<string, string[]>([
    ["script-src", ["'self'", ...[...origins].sort(), ...scripts.map(scriptHash)]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
  ]);
  for (const [name, sources] of Object.entries(csp)) {
    if (name === "reportOnly" || !Array.isArray(sources)) continue;
    const merged = directives.get(name) ?? [];
    for (const source of sources) if (!merged.includes(source)) merged.push(source);
    // 'none' allows nothing only when it is a directive's one source.
    directives.set(name, merged.length > 1 ? merged.filter(source => source !== "'none'") : merged);
  }
  const text = (entries: [string, string[]][]) => entries.map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
  const reportOnly = csp.reportOnly === true;
  return { header: text([...directives]), reportOnly, ...(reportOnly ? {} : { meta: text([...directives].filter(([name]) => !headerOnly.has(name))) }) };
}

/** The header that delivers the policy. */
export function policyHeader(policy: RenderedPolicy): string {
  return policy.reportOnly ? "content-security-policy-report-only" : "content-security-policy";
}

/**
 * The csp option for the development server: what Vite needs beside 'self', which already covers its
 * client and modules. Its HMR WebSocket needs connect-src, and the styles it injects for CSS a
 * module imports need style-src 'unsafe-inline', each only where the policy restricts it.
 */
export function developmentPolicyOptions(csp: ContentSecurityPolicyOptions | false, socket: string): ContentSecurityPolicyOptions | false {
  if (csp === false) return false;
  const added: Record<string, readonly string[]> = {};
  for (const [name, source] of [["connect-src", socket], ["style-src", "'unsafe-inline'"]] as const) {
    const sources = csp[name] ?? csp["default-src"];
    if (Array.isArray(sources)) added[name] = [...sources, source];
  }
  return { ...csp, ...added };
}
