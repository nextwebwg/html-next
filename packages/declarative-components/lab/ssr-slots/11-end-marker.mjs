// How each engine parses candidate end-marker spellings.
import { chromium, firefox, webkit } from "playwright";
const spellings = ["<?/slot?>", "<?slot-end?>", "<?end?>", "<?slot end?>"];
for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await type.launch();
  const page = await browser.newPage();
  const version = browser.version();
  await page.setContent(`<div id="host">${spellings.map((s) => `<p>${s}</p>`).join("")}</div>`);
  const nodes = await page.evaluate(() => [...document.querySelectorAll("#host p")].map((p) => {
    const n = p.firstChild;
    return n.nodeType === 7 ? `PI target="${n.target}" data="${n.data}"` : `comment "${n.data}"`;
  }));
  console.log(`${name} ${version}`);
  spellings.forEach((s, i) => console.log(`  ${s.padEnd(14)} -> ${nodes[i]}`));
  await browser.close();
}
