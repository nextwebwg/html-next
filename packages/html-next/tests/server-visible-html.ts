import { JSDOM } from "jsdom";

/** Reference names that remain observable inside inert serialized carrier content. */
export function inertCarrierReferences(html: string): string[] {
  const dom = new JSDOM(html);
  try {
    const visit = (parent: ParentNode): string[] => Array.from(parent.children).flatMap(child => [
      ...child.hasAttribute("$ref") ? [child.getAttribute("$ref")!] : [],
      ...visit(child instanceof dom.window.HTMLTemplateElement ? child.content : child),
    ]);
    return Array.from(dom.window.document.querySelectorAll<HTMLTemplateElement>("template[carrier]")).flatMap(carrier => visit(carrier.content));
  } finally { dom.window.close(); }
}

/** Visible authored HTML, retaining authored attributes while removing renderer-owned records. */
export function visibleComponentHtml(html: string): string {
  const dom = new JSDOM(html);
  try {
    const root = dom.window.document.body.firstElementChild!;
    for (const carrier of root.querySelectorAll("template[carrier]")) carrier.remove();
    for (const element of [root, ...root.querySelectorAll("*")]) for (let index = element.attributes.length - 1; index >= 0; index--) {
      const name = element.attributes[index]!.name;
      if (["component", "data-html-next-instance", "data-valid", "data-slotted"].includes(name) || /^(?:data-.*-prop-|data-.*-state$)/.test(name)) element.removeAttribute(name);
    }
    const comments: Comment[] = [];
    const walker = dom.window.document.createTreeWalker(root, 128);
    while (walker.nextNode()) comments.push(walker.currentNode as Comment);
    for (const comment of comments) if (/^html-next:|^\?(?:start|end|marker)(?:\s|\?)/.test(comment.data)) comment.remove();
    return root.outerHTML;
  } finally { dom.window.close(); }
}
