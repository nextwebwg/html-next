// J under the P4 selector checks, in Chromium's native ProcessingInstruction mode and the comment fallback.
import { chromium, firefox, webkit } from "playwright";
for (const [bname, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch(); const page = await browser.newPage();
  await page.setContent(`<!doctype html>
    <footer id="empty"><?slot name="actions"?><?slot-end?></footer>
    <div id="kids"><?slot?><b>1</b><b>2</b><?slot-end?></div>
    <div id="sib"><i>template</i><?slot?><b>projected</b><?slot-end?></div>`);
  console.log(bname.padEnd(8), JSON.stringify(await page.evaluate(() => ({
    markerType: document.getElementById("empty").firstChild?.nodeType === 7 ? "PI" : "comment",
    emptyMatches: document.getElementById("empty").matches(":empty"),
    firstChild: document.querySelector("#kids > b:first-child")?.textContent ?? null,
    direct: document.querySelectorAll("#kids > b").length,
    sibling: document.querySelector("#sib > i + b")?.textContent ?? null,
    serialized: document.getElementById("kids").innerHTML,
  }))));
  await browser.close();
}
