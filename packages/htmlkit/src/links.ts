import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { HtmlKitError, within } from "./config.js";

/** A built document's links, and the fragments that name an element in it: ids and <a name>. */
interface Document { readonly links: readonly string[]; readonly fragments: ReadonlySet<string> }

function read(html: string): Document {
  const links: string[] = [];
  const fragments = new Set<string>();
  // Template content is inert, so its links and ids aren't the document's; childNodes leaves it out.
  const visit = (node: DefaultTreeAdapterMap["parentNode"]): void => {
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      for (const { name, value } of child.attrs) {
        if (name === "id" || (name === "name" && child.tagName === "a")) fragments.add(value);
        if (name === "href" && (child.tagName === "a" || child.tagName === "area")) links.push(value);
      }
      visit(child);
    }
  };
  visit(parse(html));
  return { links, fragments };
}

/**
 * Fail when a link in a built document points under base at a page or file the output lacks, or at a
 * #fragment that names no element in its page. It reads the output, as a static host serves it.
 * documents are the deployment pathnames of the HTML the build rendered, and served names the paths a
 * server answers on request, such as server-rendered pages and endpoints, which have no file.
 */
export async function checkLinks(outDir: string, origin: string, base: string, documents: readonly string[], mode: "error" | "warn" = "error",
  served: (pathname: string) => boolean = () => false): Promise<void> {
  const parsed = new Map<string, Promise<Document>>();
  const documentAt = (file: string) => parsed.get(file) ?? parsed.set(file, readFile(file, "utf8").then(read)).get(file)!;
  // The file a pathname serves: itself, or its folder's index.html, as a static host serves it.
  const fileAt = async (pathname: string): Promise<string | undefined> => {
    let path: string;
    try { path = decodeURIComponent(pathname.slice(base.length)); } catch { return undefined; }
    for (const candidate of path === "" || path.endsWith("/") ? [path + "index.html"] : [path, path + "/index.html"]) {
      const file = join(outDir, candidate);
      if (!within(outDir, file)) return undefined;
      try { if ((await stat(file)).isFile()) return file; }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code!)) throw error; }
    }
    return undefined;
  };
  const broken: string[] = [];
  for (const source of documents) {
    for (const href of (await documentAt((await fileAt(source))!)).links) {
      const url = URL.parse(href, origin + source);
      if (url === null || url.origin !== origin || !url.pathname.startsWith(base) || served(url.pathname)) continue;
      const target = await fileAt(url.pathname);
      if (target === undefined) { broken.push(`${source} links to ${href}, which is no page or file in the build.`); continue; }
      const fragment = url.hash.slice(1);
      // An empty fragment and #top scroll to the top, and :~: starts a text fragment.
      if (fragment === "" || fragment.toLowerCase() === "top" || fragment.startsWith(":~:") || !target.endsWith(".html")) continue;
      const { fragments } = await documentAt(target);
      let decoded = fragment;
      try { decoded = decodeURIComponent(fragment); } catch { /* The fragment as written. */ }
      if (!fragments.has(fragment) && !fragments.has(decoded)) broken.push(`${source} links to ${href}, and ${url.pathname} has no element with id "${decoded}".`);
    }
  }
  if (broken.length === 0) return;
  const message = `Broken internal links:\n  ${broken.join("\n  ")}`;
  if (mode === "error") throw new HtmlKitError(message);
  console.warn(message);
}
