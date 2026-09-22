// J: processing-instruction range markers. Current parsers produce bogus comments; Chrome 148-150 (origin
// trial) produces ProcessingInstruction nodes. Hydration must read either form.
import { chromium, firefox, webkit } from "playwright";
const contexts = {
  tbody: ["<table><tbody>", "</tbody></table>", "<tr><td>Cell</td></tr>"],
  tr: ["<table><tbody><tr>", "</tr></tbody></table>", "<td>Cell</td>"],
  select: ["<select>", "</select>", "<option>One</option>"],
  p_text: ["<p>Hello ", "</p>", "world"],
  button: ["<button>", "</button>", "Save <b>now</b>"],
  ul: ["<ul>", "</ul>", "<li>One</li>"],
};
const out = {};
for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();
  for (const [ctx, [open, close, payload]] of Object.entries(contexts)) {
    await page.setContent(`<!doctype html><div id="host">${open}<?slot name="x"?>${payload}<?end?>${close}</div>`);
    (out[ctx] ??= {})[bname] = await page.evaluate(() => {
      const host = document.getElementById("host");
      // Accept both forms: a ProcessingInstruction node, or the comment today's parsers make of it.
      const marker = (node) => node.nodeType === 7 ? { target: node.target, data: node.data }
        : node.nodeType === 8 && /^\?[A-Za-z][-A-Za-z0-9]*/.test(node.data)
          ? { target: node.data.slice(1).split(/\s|\?/)[0], data: node.data.slice(1).replace(/^\S+\s*/, "").replace(/\?$/, "") }
          : null;
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_COMMENT | 0x40 /* PI */);
      const found = []; while (walker.nextNode()) found.push(walker.currentNode);
      const [start, end] = found;
      if (!start || !end) return `markers: ${found.length}`;
      if (start.parentNode !== end.parentNode) return "split";
      const range = document.createRange(); range.setStartAfter(start); range.setEndBefore(end);
      const nodes = [...start.parentNode.childNodes].slice([...start.parentNode.childNodes].indexOf(start) + 1, [...start.parentNode.childNodes].indexOf(end));
      return { nodeType: start.nodeType === 7 ? "PI" : "comment", start: marker(start), parent: start.parentNode.localName, content: range.toString(), nodes: nodes.length, empty: start.parentNode.matches(":empty") };
    });
  }
  await browser.close();
}
console.log(JSON.stringify(out, null, 1));
