// Can each engine create PIs in an HTML document, and how do they serialize and re-parse?
import { chromium, firefox, webkit } from "playwright";
for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await type.launch();
  const page = await browser.newPage();
  await page.setContent("<p id=p></p>");
  const r = await page.evaluate(() => {
    const p = document.getElementById("p");
    try {
      p.append(document.createProcessingInstruction("start", 'slot="a&gt;b"'), "x", document.createProcessingInstruction("end", ""));
    } catch (error) { return { error: String(error) }; }
    const html = p.innerHTML;
    const again = document.createElement("div"); again.setHTMLUnsafe(html);
    return { html, reparsed: [...again.childNodes].map((n) => `${n.nodeType}:${n.nodeType === 7 ? n.target + "|" + n.data : n.nodeType === 8 ? n.data : n.textContent}`) };
  });
  console.log(name, JSON.stringify(r));
  await browser.close();
}
