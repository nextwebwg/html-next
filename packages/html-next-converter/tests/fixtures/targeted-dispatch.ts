import assert from "node:assert/strict";
import type { Page } from "playwright";

/** Exercise native targeting, collection fanout, and independent cancellation in every target. */
export async function assertTargetedDispatch(page: Page, detail: unknown = { reason: "action" }): Promise<void> {
  const actual = await page.evaluate(() => {
    const root = document.querySelector("#case")!;
    const button = root.querySelector("button")!;
    const rows = [...root.querySelectorAll("[data-receiver]")];
    const events: CustomEvent[] = [];
    const targets: string[] = [];
    let bubbled = 0;
    const observe = (event: Event) => {
      events.push(event as CustomEvent);
      targets.push(event.target === button ? "button" : (event.target as Element).getAttribute("data-receiver")!);
      event.preventDefault();
    };
    button.addEventListener("saved", observe);
    for (const row of rows) row.addEventListener("saved", observe);
    const onRoot = () => { bubbled++; };
    root.addEventListener("saved", onRoot);
    root.dispatchEvent(new Event("request-one"));
    root.dispatchEvent(new Event("request-all"));
    button.removeEventListener("saved", observe);
    for (const row of rows) row.removeEventListener("saved", observe);
    root.removeEventListener("saved", onRoot);
    return { targets, bubbled, details: events.map(event => event.detail),
      independent: new Set(events).size === 3, sharedPayload: events[1]?.detail === events[2]?.detail,
      flags: events.map(event => [event.bubbles, event.composed, event.cancelable, event.defaultPrevented]) };
  });
  await page.waitForFunction(() => [...document.querySelectorAll("#case [data-receiver]")].every(element => element.getAttribute("data-hits") === "1"));
  assert.deepEqual(actual, { targets: ["button", "1", "2"], bubbled: 0,
    details: [detail, detail, detail], independent: true, sharedPayload: true,
    flags: [[false, false, true, true], [false, false, true, true], [false, false, true, true]] }, `Targeting differs at ${page.url()}`);
}
