import assert from "node:assert/strict";

import type { Page } from "playwright";

/** Compare rendered RGBA pixels, not the PNG encoders' byte streams. */
export async function assertPixelsEqual(page: Page, actual: Buffer, expected: Buffer, message: string): Promise<void> {
  if (actual.equals(expected)) return;

  const difference = await page.evaluate(async ([actualPng, expectedPng]: [string, string]) => {
    const decode = async (encoded: string) => {
      const response = await fetch(`data:image/png;base64,${encoded}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) throw new Error("Canvas 2D context is unavailable");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const [left, right] = await Promise.all([decode(actualPng), decode(expectedPng)]);
    if (left.width !== right.width || left.height !== right.height) {
      return { size: `${left.width}x${left.height} versus ${right.width}x${right.height}`, changed: -1, first: null };
    }
    let changed = 0;
    let first: { x: number; y: number; actual: number[]; expected: number[] } | null = null;
    for (let offset = 0; offset < left.data.length; offset += 4) {
      if (left.data[offset] === right.data[offset] && left.data[offset + 1] === right.data[offset + 1] &&
        left.data[offset + 2] === right.data[offset + 2] && left.data[offset + 3] === right.data[offset + 3]) continue;
      changed += 1;
      if (first === null) {
        const pixel = offset / 4;
        first = {
          x: pixel % left.width,
          y: Math.floor(pixel / left.width),
          actual: Array.from(left.data.slice(offset, offset + 4)),
          expected: Array.from(right.data.slice(offset, offset + 4)),
        };
      }
    }
    return { size: `${left.width}x${left.height}`, changed, first };
  }, [actual.toString("base64"), expected.toString("base64")] as [string, string]);

  assert.equal(difference.changed, 0, `${message}: ${difference.changed} differing RGBA pixels at ${difference.size}; first=${JSON.stringify(difference.first)}`);
}

/** Record whether a mismatch survives another paint and whether page input state differs. */
export async function diagnosePixelMismatch(actualPage: Page, expectedPage: Page, actual: Buffer, expected: Buffer, selector: string): Promise<unknown> {
  const state = async (page: Page) => page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector)!;
    const button = root.querySelector("button");
    const style = button === null ? null : getComputedStyle(button);
    return {
      activeElement: document.activeElement?.localName,
      documentFocused: document.hasFocus(),
      hovered: Array.from(document.querySelectorAll(":hover"), (element) => element.localName),
      active: Array.from(document.querySelectorAll(":active"), (element) => element.localName),
      focusVisible: Array.from(document.querySelectorAll(":focus-visible"), (element) => element.localName),
      buttonBackground: style?.backgroundColor,
      buttonBorder: style?.borderColor,
    };
  }, selector);
  const [actualState, expectedState] = await Promise.all([state(actualPage), state(expectedPage)]);
  const recapture = async (page: Page) => {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    return page.locator(selector).screenshot({ animations: "disabled" });
  };
  const [nextActual, nextExpected] = await Promise.all([recapture(actualPage), recapture(expectedPage)]);
  const difference = async (page: Page, left: Buffer, right: Buffer) => {
    try { await assertPixelsEqual(page, left, right, "recapture"); return "equal"; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  return {
    actualState, expectedState,
    actualChanged: await difference(actualPage, nextActual, actual),
    expectedChanged: await difference(expectedPage, nextExpected, expected),
    recapturedParity: await difference(actualPage, nextActual, nextExpected),
  };
}
