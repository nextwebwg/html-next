import assert from "node:assert/strict";
import type { Page } from "playwright";

/** The same first-value, write-ownership and reconnection contract for each converter. */
export async function exerciseStateInitialization(page: Page, bundle: string): Promise<void> {
  const errors: string[] = [];
  page.setDefaultTimeout(5_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent('<div id="mount"></div>'); await page.addScriptTag({ path: bundle });
  await page.waitForFunction(() => (window as any).source && (window as any).childPort);
  assert.deepEqual(await page.evaluate(() => ({ value: (window as any).host.state.draft, status: (window as any).port.status("draft").ready,
    child: (window as any).childPort.status("product").ready, context: (window as any).childPort.status("parentDraft").ready, reads: (window as any).reads || [] })),
  { value: undefined, status: false, child: false, context: false, reads: [] });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("input.early").fill("Early edit"); await page.locator("input.early").fill("");
  await page.waitForFunction(() => document.querySelector(".early-state")?.textContent === "Early ready.");
  assert.equal(await page.evaluate(() => (window as any).host.state.early), "");
  await page.evaluate(() => { (window as any).host.state.early = null; (window as any).host.state.same = undefined; (window as any).source.publish({ status: { ready: false, pending: true, error: null, stale: false } }); });
  await page.waitForFunction(() => (window as any).port.status("draft").pending && (window as any).childPort.status("parentDraft").pending);
  await page.evaluate(() => (window as any).source.publish({ status: { ready: false, pending: false, stale: false, error: { name: "Error", message: "Offline" } } }));
  await page.waitForFunction(() => (window as any).port.status("draft").error?.message === "Offline" && (window as any).childPort.status("parentDraft").error?.message === "Offline");
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => [document.querySelector("p")?.textContent, document.querySelector("em")?.textContent]), ["Offline", "Offline"]);
  await page.evaluate(() => (window as any).source.publish({ value: { name: "Old" }, status: { ready: true, pending: true, stale: true, error: null } }));
  await page.waitForFunction(() => (window as any).port.read("product").name === "Old");
  assert.equal(await page.evaluate(() => (window as any).host.state.draft), undefined);
  assert.equal(await page.evaluate(() => { (window as any).source.publish({ value: { name: "Remote" }, status: { ready: true, pending: false, stale: false, error: null } });
    (window as any).host.state.draft.name = "Edited"; return (window as any).port.read("product").name; }), "Remote");
  await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Edited" && document.querySelector(".context")?.textContent === "Edited" && document.querySelector(".child")?.textContent === "Edited" && document.querySelector(".driven")?.textContent === "Edited");
  assert.equal(await page.evaluate(() => (window as any).host.state.early), null);
  assert.equal(await page.evaluate(() => (window as any).host.state.same), null);
  await page.locator("input.draft").fill("Control edit");
  await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Control edit" && document.querySelector(".context")?.textContent === "Control edit" && document.querySelector(".child")?.textContent === "Control edit" && document.querySelector(".driven")?.textContent === "Control edit");
  assert.equal(await page.locator(".context-draft").textContent(), "Edited");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Remote!" && document.querySelector(".driven")?.textContent === "Remote!");
  await page.evaluate(() => (window as any).source.publish({ value: { name: "New" }, status: { ready: true, pending: false, stale: false, error: null } }));
  await page.waitForFunction(() => document.querySelector("h2")?.textContent === "Remote!" && document.querySelector(".forward")?.textContent === "Remote");
  assert.deepEqual(await page.evaluate(() => (window as any).reads), ["Edited", "Control edit", "Remote!"]);
  await page.evaluate(() => (window as any).source.publish({ value: { name: "New" }, status: { ready: true, pending: false, stale: false, error: { name: "Error", message: "Refresh failed" } } }));
  assert.deepEqual(await page.evaluate(() => (window as any).port.status("draft")), { ready: true, pending: false, error: null, stale: false });
  await page.evaluate(() => { (window as any).detached = (window as any).host.root; (window as any).detached.remove(); });
  await page.waitForFunction(() => (window as any).activation.aborted);
  await page.evaluate(() => document.querySelector("#mount")!.append((window as any).detached));
  await page.waitForFunction(() => (window as any).activations === 2);
  await page.evaluate(() => (window as any).source.publish({ value: { name: "Reconnected" }, status: { ready: true, pending: false, stale: false, error: null } }));
  assert.equal(await page.locator("h2").textContent(), "Remote!");
  assert.deepEqual(await page.evaluate(() => (window as any).reads), ["Edited", "Control edit", "Remote!"]);
  await page.evaluate(() => (window as any).host.reset("draft"));
  assert.equal(await page.evaluate(() => (window as any).host.state.draft), null);
  assert.deepEqual(errors, []);
}
