import { chromium, firefox, webkit } from "playwright";
const wrap = {
  A_slot: (c) => `<slot name="x">${c}</slot>`,
  C_comment: (c) => `<!--slot:x-->${c}<!--/slot-->`,
  D_span: (c) => `<span data-component-slot="x" style="display:contents">${c}</span>`,
  none: (c) => c,
};
const out = {};
for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();
  for (const [shape, w] of Object.entries(wrap)) {
    await page.setContent(`<!doctype html><body>
      <select id="sel">${w("<option>One</option><option>Two</option>")}</select>
      <ul id="list">${w("<li>One</li><li>Two</li>")}</ul>
      <button id="btn">${w("Save <b>now</b>")}</button>
      <div id="flex" style="display:flex;gap:10px">${w('<i style="width:50px">a</i><i style="width:50px">b</i>')}</div>
      <div id="grid" style="display:grid;grid-template-columns:40px 60px">${w("<i>a</i><i>b</i>")}</div>
    </body>`);
    const r = await page.evaluate(() => {
      const sel = document.getElementById("sel");
      const flexKids = [...document.querySelectorAll("#flex i")].map(e => Math.round(e.getBoundingClientRect().left));
      const gridKids = [...document.querySelectorAll("#grid i")].map(e => Math.round(e.getBoundingClientRect().width));
      const slot = document.querySelector("#btn slot");
      return {
        selectInner: sel.innerHTML.replace(/\s+/g, " ").slice(0, 80),
        selectOptions: sel.options.length,
        flexLeft: flexKids.join(","), gridWidths: gridKids.join(","),
        slotDisplay: slot ? getComputedStyle(slot).display : null,
      };
    });
    const ax = {
      list: await page.locator("#list").ariaSnapshot(),
      button: await page.locator("#btn").ariaSnapshot(),
      select: await page.locator("#sel").ariaSnapshot(),
    };
    (out[shape] ??= {})[bname] = { ...r, ax };
  }
  await browser.close();
}
console.log(JSON.stringify(out, null, 1));
