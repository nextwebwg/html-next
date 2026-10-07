import type { HeadElement, RenderedHead } from "./types.js";
export const defaultHeadElements: readonly HeadElement[] = [
  { tag: "meta", attributes: { charset: "utf-8" } },
  { tag: "meta", attributes: { name: "viewport", content: "width=device-width, initial-scale=1" } },
];
export function escapeHTML(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export function documentHTML(body: string, head: RenderedHead, assets = ""): string {
  const elements = head.elements ?? defaultHeadElements;
  const metadata = [...elements.filter(element => element.tag === "meta" && element.attributes.charset !== undefined),
    ...elements.filter(element => element.tag !== "meta" || element.attributes.charset === undefined)]
    .map(element => `<${element.tag}${Object.entries(element.attributes).map(([name, value]) => ` ${name}="${escapeHTML(value)}"`).join("")}>`).join("");
  return `<!doctype html>\n<html lang="${escapeHTML(head.lang ?? "en")}"><head>${metadata}` +
    `<title>${escapeHTML(head.title ?? "HTMLKit")}</title>` +
    (head.description === undefined ? "" : `<meta name="description" content="${escapeHTML(head.description)}">`) +
    `${assets}</head><body>${body}</body></html>`;
}
