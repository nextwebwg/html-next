/**
 * The application-components source list (components#document-authority): a CSP source list whose
 * matching URLs supply application components. It always includes `'self'`.
 *
 * CSP's own matching runs only inside the browser's policy checks, so this is the "Does url match
 * source list" algorithm of Content Security Policy Level 3 (§6.7.2.5–6.7.2.10), for the source
 * expressions that name URLs: `*`, scheme sources, host sources and `'self'`.
 */

const SCHEME_SOURCE = /^([a-z][a-z0-9+.-]*):$/i;
const HOST_SOURCE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\*|\d+))?(\/[^?#]*)?$/i;
const DEFAULT_PORTS: Readonly<Record<string, string>> = { "http:": "80", "https:": "443", "ws:": "80", "wss:": "443" };

/** A secure upgrade of a scheme matches it: `http:` covers `https:`, and `ws:` covers `wss:`. */
function schemeMatches(expression: string, scheme: string): boolean {
  expression = expression.toLowerCase();
  return expression === scheme || (expression === "http" && scheme === "https") || (expression === "ws" && scheme === "wss");
}

/**
 * Whether `url` matches one source expression, as the URL prefix it approves: its origin, or the
 * path a host source names. Undefined when it does not match.
 */
function matchesExpression(expression: string, url: URL, self: URL): string | undefined {
  const scheme = url.protocol.slice(0, -1);
  const origin = new URL("/", url).href;
  if (expression === "*") return ["http", "https", "ws", "wss"].includes(scheme) || url.protocol === self.protocol ? origin : undefined;
  if (expression.toLowerCase() === "'self'") {
    if (url.origin === self.origin) return origin;
    // A secure upgrade of the document's own host and port.
    return url.host === self.host && ((self.protocol === "http:" && url.protocol === "https:") || (self.protocol === "ws:" && url.protocol === "wss:"))
      ? origin : undefined;
  }
  const schemeSource = SCHEME_SOURCE.exec(expression);
  if (schemeSource !== null) return schemeMatches(schemeSource[1]!, scheme) ? origin : undefined;
  const host = HOST_SOURCE.exec(expression);
  if (host === null || url.hostname === "") return undefined;
  const [, sourceScheme, sourceHost, sourcePort, sourcePath] = host;
  if (!schemeMatches(sourceScheme ?? self.protocol.slice(0, -1), scheme)) return undefined;
  const hostname = url.hostname.toLowerCase();
  const pattern = sourceHost!.toLowerCase();
  if (pattern !== "*" && (pattern.startsWith("*.") ? !hostname.endsWith(pattern.slice(1)) : hostname !== pattern)) return undefined;
  const port = url.port === "" ? DEFAULT_PORTS[url.protocol] ?? "" : url.port;
  if (sourcePort === undefined ? url.port !== "" : sourcePort !== "*" && sourcePort !== port) return undefined;
  if (sourcePath === undefined || sourcePath === "/") return origin;
  const path = decodeURIComponent(url.pathname);
  const wanted = decodeURIComponent(sourcePath);
  if (!wanted.endsWith("/")) return path === wanted ? new URL("./", url).href : undefined;
  return path.startsWith(wanted) ? new URL(sourcePath, origin).href : undefined;
}

function sourceExpressions(sources: string): string[] {
  return sources.split(/[\t\n\f\r ]+/).filter((source) => source !== "");
}

/** Whether `url` matches the space-separated `sources`, with `'self'` always included. */
export function matchesSourceList(url: string, sources: string, document: string): boolean {
  const target = new URL(url);
  const self = new URL(document);
  return ["'self'", ...sourceExpressions(sources)].some((expression) => matchesExpression(expression, target, self) !== undefined);
}

/**
 * The URL prefix a listed source approves for `url`, or undefined when the list does not name it.
 * A live component root there is the application's own, as one under `'self'` is.
 */
export function listedSourceRoot(url: string, sources: string, document: string): string | undefined {
  const target = new URL(url);
  const self = new URL(document);
  for (const expression of sourceExpressions(sources)) {
    const root = matchesExpression(expression, target, self);
    if (root !== undefined) return root;
  }
  return undefined;
}
