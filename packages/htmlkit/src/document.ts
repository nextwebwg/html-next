import type { PageHead } from "./types.js";
export function escapeHTML(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export function documentHTML(body: string, head: PageHead, assets = ""): string {
  return `<!doctype html>\n<html lang="${escapeHTML(head.lang ?? "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHTML(head.title ?? "HTMLKit")}</title>` +
    (head.description === undefined ? "" : `<meta name="description" content="${escapeHTML(head.description)}">`) +
    `${assets}</head><body>${body}</body></html>`;
}
