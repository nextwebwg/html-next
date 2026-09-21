import { chromium, firefox, webkit } from "playwright";
// Each context: parent open/close tags and a slotted payload valid for that parent.
const contexts = {
  button:   ["<button>", "</button>", 'Save <b>now</b>'],
  dialog:   ["<dialog open>", "</dialog>", '<p>Body</p>'],
  select:   ['<select>', "</select>", '<option>One</option><option>Two</option>'],
  ul:       ["<ul>", "</ul>", "<li>One</li><li>Two</li>"],
  tbody:    ["<table><tbody>", "</tbody></table>", "<tr><td>Cell</td></tr>"],
  tr:       ["<table><tbody><tr>", "</tr></tbody></table>", "<td>Cell</td>"],
  td:       ["<table><tbody><tr><td>", "</td></tr></tbody></table>", "Cell <b>x</b>"],
  p:        ["<p>", "</p>", "Text <em>inline</em>"],
  p_block:  ["<p>", "</p>", "<div>Block</div>"],
  a:        ['<a href="#">', "</a>", "Link <b>x</b>"],
  label:    ["<label>", "</label>", 'Name <input>'],
  summary:  ["<details><summary>", "</summary></details>", "Title <b>x</b>"],
  dl:       ["<dl>", "</dl>", "<dt>T</dt><dd>D</dd>"],
};
const shapes = {
  A_slot:    (c) => `<slot name="x">${c}</slot>`,
  C_comment: (c) => `<!--slot:x-->${c}<!--/slot-->`,
  D_span:    (c) => `<span data-component-slot="x" style="display:contents">${c}</span>`,
  E_attr:    (c) => c.replace(/<(\w+)(?=[\s>])/, '<$1 slot="x"'),
};
const results = {};
for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();
  for (const [ctx, [open, close, payload]] of Object.entries(contexts)) {
    for (const [shape, wrap] of Object.entries(shapes)) {
      const html = `<div id="host">${open}${wrap(payload)}${close}</div>`;
      await page.setContent(`<!doctype html><body>${html}</body>`);
      const ok = await page.evaluate(({ shape, payloadText }) => {
        const host = document.getElementById("host");
        const parent = host.firstElementChild;
        // Innermost intended parent: deepest first-element chain matching the context open tags.
        let inner = parent; while (inner.firstElementChild && ["TABLE","TBODY","TR","DETAILS"].includes(inner.tagName) && !(shape==="A_slot"||shape==="D_span") ) inner = inner.firstElementChild;
        const text = (n) => n.textContent.replace(/\s+/g, " ").trim();
        if (shape === "A_slot" || shape === "D_span") {
          const region = host.querySelector(shape === "A_slot" ? "slot" : "[data-component-slot]");
          if (!region) return "region lost";
          // Region must stay inside the context parent (not foster-parented out) and hold the payload.
          if (!parent.contains(region)) return "region moved out of parent";
          if (text(region) !== payloadText) return `region holds "${text(region)}"`;
          return "ok";
        }
        if (shape === "C_comment") {
          const walker = document.createTreeWalker(host, NodeFilter.SHOW_COMMENT); const cs = [];
          while (walker.nextNode()) cs.push(walker.currentNode);
          if (cs.length !== 2) return `comments: ${cs.length}`;
          if (!parent.contains(cs[0]) || !parent.contains(cs[1])) return "comment moved out of parent";
          const r = document.createRange(); r.setStartAfter(cs[0]); r.setEndBefore(cs[1]);
          const t = r.toString().replace(/\s+/g, " ").trim();
          return t === payloadText ? "ok" : `between: "${t}"`;
        }
        const marked = host.querySelector('[slot="x"]');
        if (!marked) return "slot attr lost";
        return parent.contains(marked) ? "ok" : "moved";
      }, { shape, payloadText: payload.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() });
      (results[`${ctx}`] ??= {})[`${shape}`] = { ...(results[ctx]?.[shape] ?? {}), [bname]: ok };
    }
  }
  await browser.close();
}
for (const [ctx, row] of Object.entries(results)) {
  console.log(ctx.padEnd(8), Object.entries(row).map(([s, r]) => {
    const vals = Object.values(r); const same = vals.every(v => v === vals[0]);
    return `${s}=${same ? vals[0] : JSON.stringify(r)}`;
  }).join(" | "));
}
