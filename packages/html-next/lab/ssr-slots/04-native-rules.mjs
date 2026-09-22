// R11: native content-model rules and form behavior with each boundary shape before the first child.
import { chromium, firefox, webkit } from "playwright";
const shapes = {
  none: (c) => c,
  C_comment: (c) => `<!--slot:x-->${c}<!--/slot-->`,
  H_template: (c) => `<template data-s></template>${c}<template data-e></template>`,
  D_span: (c) => `<span data-component-slot="x" style="display:contents">${c}</span>`,
};
const out = {};
for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();
  for (const [shape, w] of Object.entries(shapes)) {
    await page.setContent(`<!doctype html><form id="f">
      <fieldset id="fs">${w("<legend>Group</legend>")}<input name="a" value="1"></fieldset>
      <details id="d" open>${w("<summary>More</summary>")}<p>Body</p></details>
      <table id="t">${w("<caption>Cap</caption>")}<tbody><tr><td>x</td></tr></tbody></table>
      <label id="l">${w("Name <input name='b' value='2'>")}</label>
      <select name="c">${w("<option value='3' selected>Three</option>")}</select>
    </form>`);
    out[`${shape}`] ??= {};
    out[shape][bname] = {
      ...(await page.evaluate(() => {
        const f = document.getElementById("f");
        const fs = document.getElementById("fs");
        return {
          legendRendered: getComputedStyle(fs.querySelector("legend")).float === "none" && fs.querySelector("legend").getBoundingClientRect().top < fs.querySelector("input").getBoundingClientRect().top,
          summaryIsToggle: document.getElementById("d").querySelector("summary")?.getBoundingClientRect().height > 0,
          captionIsCaption: document.getElementById("t").caption?.textContent ?? null,
          labelControl: document.getElementById("l").control?.name ?? null,
          formData: [...new FormData(f)].map(([k, v]) => `${k}=${v}`).join("&"),
          elements: f.elements.length,
        };
      })),
      ax: {
        group: await page.locator("#fs").ariaSnapshot(),
        details: await page.locator("#d").ariaSnapshot(),
      },
    };
  }
  await browser.close();
}
console.log(JSON.stringify(out, null, 1));
