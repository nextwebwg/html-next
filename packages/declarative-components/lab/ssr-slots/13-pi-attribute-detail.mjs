// Detail: how Chromium parses PI data into attributes, per spelling.
import { chromium } from "playwright";
const spellings = [
  `<?start slot?>`,
  `<?start slot ?>`,
  `<?start slot=""?>`,
  `<?start slot="title" fallback=""?>`,
  `<?start slot="title" fallback?>`,
  `<?start slot="title"?>`,
  `<?start fallback slot="title"?>`,
  `<?start slot=title?>`,
  `<?marker slot="footer"?>`,
];
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<div id="host">${spellings.map((s) => `<p>${s}</p>`).join("")}</div>`);
const rows = await page.evaluate(() => [...document.querySelectorAll("#host p")].map((p) => {
  const n = p.firstChild;
  return {
    type: n.nodeType,
    target: n.target,
    data: n.data,
    hasApi: typeof n.getAttribute,
    names: n.getAttributeNames?.() ?? null,
    slot: n.getAttribute?.("slot") ?? null,
  };
}));
spellings.forEach((s, i) => console.log(s.padEnd(34), JSON.stringify(rows[i])));
await browser.close();
