// PI attributes (whatwg/dom#1454, merged June 2026): does each engine expose them?
import { chromium, firefox, webkit } from "playwright";
const markup = `<p><?start slot="title" fallback?>Untitled<?end?></p><p><?marker slot="footer"?></p>`;
for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await type.launch();
  const page = await browser.newPage();
  await page.setContent(`<div id="host">${markup}</div>`);
  const nodes = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.getElementById("host"), 0x80 | 0x40);
    const out = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      out.push(n.nodeType === 7
        ? `PI ${n.target} slot=${JSON.stringify(n.getAttribute?.("slot") ?? "no API")} fallback=${n.hasAttribute?.("fallback") ?? "no API"}`
        : `comment "${n.data}"`);
    }
    return out;
  });
  console.log(`${name} ${browser.version()}`);
  for (const line of nodes) console.log(`  ${line}`);
  await browser.close();
}
