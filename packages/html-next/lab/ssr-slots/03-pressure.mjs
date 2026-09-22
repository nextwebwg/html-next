// Pressure tests: text merging, foreign shadow roots, selector side effects, DSD hosts, template markers.
import { chromium, firefox, webkit } from "playwright";
const results = {};
const record = (test, browser, value) => ((results[test] ??= {})[browser] = value);
for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();

  // P2: template text adjacent to projected text after a serialize/parse round trip.
  await page.setContent(`<!doctype html><p id="p">Hello ${"world"}</p>`);
  record("P2 text merge: 'Hello ' + projected 'world'", bname,
    await page.evaluate(() => [...document.getElementById("p").childNodes].map((n) => JSON.stringify(n.textContent)).join(" | ")));

  // P3: a kept <slot> element inside a foreign shadow tree whose host has light children.
  await page.setContent(`<!doctype html><div id="host"><span>HOST CHILD</span></div>`);
  record("P3 <slot> region inside a foreign shadow root", bname, await page.evaluate(() => {
    const root = document.getElementById("host").attachShadow({ mode: "open" });
    root.innerHTML = `<button><slot>Projected label</slot></button>`;
    const button = root.querySelector("button");
    const slot = root.querySelector("slot");
    return { assigned: slot.assignedNodes().map((n) => n.textContent), renderedText: button.innerText };
  }));

  // P4: selector side effects of region wrappers and <template> markers.
  const shapes = {
    none: (c) => c,
    A_slot: (c) => `<slot>${c}</slot>`,
    D_span: (c) => `<span style="display:contents" data-component-slot="">${c}</span>`,
    H_template: (c) => `<template data-component-slot=""></template>${c}<template data-component-slot-end></template>`,
    C_comment: (c) => `<!--slot:-->${c}<!--/slot-->`,
  };
  const p4 = {};
  for (const [shape, wrap] of Object.entries(shapes)) {
    await page.setContent(`<!doctype html>
      <footer id="empty">${wrap("")}</footer>
      <div id="kids">${wrap("<b>1</b><b>2</b>")}</div>
      <div id="sib"><i>template</i>${wrap("<b>projected</b>")}</div>`);
    p4[shape] = await page.evaluate(() => ({
      emptyMatches: document.getElementById("empty").matches(":empty"),
      firstChildIsProjected: document.querySelector("#kids > b:first-child")?.textContent ?? null,
      directChildProjected: document.querySelectorAll("#kids > b").length,
      siblingCombinator: document.querySelector("#sib > i + b")?.textContent ?? null,
    }));
  }
  record("P4 selectors (want: empty true, first 1, direct 2, sibling projected)", bname, p4);

  // P9: which native roots accept a declarative shadow root.
  const hosts = ["div", "span", "button", "dialog", "select", "input", "textarea", "fieldset", "ul", "li", "label", "a", "td", "section", "p", "form"];
  record("P9 DSD attaches to", bname, await page.evaluate(async (hosts) => {
    const ok = [];
    for (const tag of hosts) {
      const box = document.createElement("div");
      box.setHTMLUnsafe(`<${tag}><template shadowrootmode="open"><slot></slot></template>x</${tag}>`);
      const el = box.firstElementChild;
      if (el?.shadowRoot) ok.push(tag);
    }
    return ok.join(" ");
  }, hosts));

  // H: <template> markers survive table/select/list parsing and stay inside the parent.
  const contexts = {
    tbody: ["<table><tbody>", "</tbody></table>", "<tr><td>Cell</td></tr>"],
    tr: ["<table><tbody><tr>", "</tr></tbody></table>", "<td>Cell</td>"],
    select: ["<select>", "</select>", "<option>One</option>"],
    ul: ["<ul>", "</ul>", "<li>One</li>"],
    button: ["<button>", "</button>", "Save"],
    p: ["<p>", "</p>", "Text"],
  };
  const h = {};
  for (const [ctx, [open, close, payload]] of Object.entries(contexts)) {
    await page.setContent(`<!doctype html><div id="host">${open}<template data-s></template>${payload}<template data-e></template>${close}</div>`);
    h[ctx] = await page.evaluate(() => {
      const [s, e] = document.querySelectorAll("#host template");
      if (!s || !e) return "marker lost";
      if (s.parentNode !== e.parentNode) return "markers split";
      const r = document.createRange(); r.setStartAfter(s); r.setEndBefore(e);
      return `ok in <${s.parentNode.localName}>: "${r.toString().trim()}"`;
    });
  }
  record("H template markers", bname, h);
  await browser.close();
}
console.log(JSON.stringify(results, null, 1));
