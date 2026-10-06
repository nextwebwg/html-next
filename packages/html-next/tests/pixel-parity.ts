import assert from "node:assert/strict";

import type { Browser, BrowserType, Page } from "playwright";

/** Use one text raster path for both pages in Chromium's cross-page pixel comparisons. */
export function launchParityBrowser(browserType: BrowserType): Promise<Browser> {
  // Partial raster can retain one-channel rounding differences at native control corners after edits.
  // Full raster preserves exact cross-page pixel checks without changing the controls or their styles.
  // https://chromium.googlesource.com/chromium/src/+/aa63f203aea2ed4b43e4bfc18a04905813df56d8/content/public/common/content_switches.cc
  return browserType.launch({ headless: true, ...(browserType.name() === "chromium"
    ? { args: ["--disable-lcd-text", "--disable-partial-raster"] } : {}) });
}

interface PixelDifference {
  readonly size: string;
  readonly changed: number;
  readonly maxChannelDelta: number;
  readonly first: { readonly x: number; readonly y: number; readonly actual: number[]; readonly expected: number[] } | null;
}

async function pixelDifference(page: Page, actual: Buffer, expected: Buffer): Promise<PixelDifference> {
  if (actual.equals(expected)) return { size: "same PNG", changed: 0, maxChannelDelta: 0, first: null };
  return page.evaluate(async ([actualPng, expectedPng]: [string, string]) => {
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
      return { size: `${left.width}x${left.height} versus ${right.width}x${right.height}`, changed: -1, maxChannelDelta: 255, first: null };
    }
    let changed = 0;
    let maxChannelDelta = 0;
    let first: { x: number; y: number; actual: number[]; expected: number[] } | null = null;
    for (let offset = 0; offset < left.data.length; offset += 4) {
      if (left.data[offset] === right.data[offset] && left.data[offset + 1] === right.data[offset + 1] &&
        left.data[offset + 2] === right.data[offset + 2] && left.data[offset + 3] === right.data[offset + 3]) continue;
      changed += 1;
      for (let channel = 0; channel < 4; channel += 1) {
        maxChannelDelta = Math.max(maxChannelDelta, Math.abs(left.data[offset + channel]! - right.data[offset + channel]!));
      }
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
    return { size: `${left.width}x${left.height}`, changed, maxChannelDelta, first };
  }, [actual.toString("base64"), expected.toString("base64")] as [string, string]);
}

async function diagnosePixelMismatch(actualPage: Page, expectedPage: Page | undefined, actual: Buffer, expected: Buffer) {
  const state = async (page: Page) => page.evaluate(() => {
    const button = document.querySelector("#case button");
    const style = button === null ? null : getComputedStyle(button);
    // A form control named "id" shadows the form's id property, so read the attribute.
    const name = (element: Element) => {
      const id = element.getAttribute("id");
      return id ? `${element.localName}#${id}` : element.localName;
    };
    return {
      activeElement: document.activeElement && name(document.activeElement),
      documentFocused: document.hasFocus(),
      // Fixtures without a doctype use quirks mode, where bare :hover and :active match only links; :is() is exempt.
      // https://quirks.spec.whatwg.org/#the-active-and-hover-quirk
      hovered: Array.from(document.querySelectorAll(":is(:hover)"), name),
      active: Array.from(document.querySelectorAll(":is(:active)"), name),
      focusVisible: Array.from(document.querySelectorAll(":focus-visible"), name),
      buttonBackground: style?.backgroundColor,
      buttonBorder: style?.borderColor,
    };
  });
  const actualState = await state(actualPage);
  const expectedState = expectedPage === undefined ? undefined : await state(expectedPage);
  const recapture = async (page: Page, previous: Buffer) => {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const viewport = page.viewportSize();
    const fullPage = viewport !== null && previous.readUInt32BE(16) === viewport.width && previous.readUInt32BE(20) === viewport.height;
    return fullPage || await page.locator("#case").count() === 0
      ? page.screenshot({ animations: "disabled" })
      : page.locator("#case").screenshot({ animations: "disabled" });
  };
  const nextActual = await recapture(actualPage, actual);
  const nextExpected = expectedPage === undefined ? undefined : await recapture(expectedPage, expected);
  return {
    actualState, expectedState,
    actualChanged: await pixelDifference(actualPage, nextActual, actual),
    expectedChanged: expectedPage === undefined || nextExpected === undefined ? undefined : await pixelDifference(expectedPage, nextExpected, expected),
    recapturedParity: nextExpected === undefined ? undefined : await pixelDifference(actualPage, nextActual, nextExpected),
  };
}

/** Compare rendered RGBA pixels, not the PNG encoders' byte streams. */
export async function assertPixelsEqual(page: Page, actual: Buffer, expected: Buffer, message: string, expectedPage?: Page,
  tolerance?: { readonly maxChangedPixels: number; readonly maxChannelDelta: number }): Promise<void> {
  const difference = await pixelDifference(page, actual, expected);
  if (difference.changed === 0) return;
  if (tolerance !== undefined && difference.changed > 0 && difference.changed <= tolerance.maxChangedPixels &&
    difference.maxChannelDelta <= tolerance.maxChannelDelta) return;
  let diagnostics: unknown;
  try {
    const recaptured = await diagnosePixelMismatch(page, expectedPage, actual, expected);
    diagnostics = recaptured;
    // Native control paint can settle after DOM updates and action completion.
    // Allow one settled recapture of separate live pages, still requiring exact RGBA equality.
    // Frozen PNGs and snapshots from one page remain strict: recapturing one page cannot validate them.
    if (expectedPage !== undefined && expectedPage !== page && recaptured.recapturedParity?.changed === 0) return;
  }
  catch (error) { diagnostics = { error: String(error) }; }
  assert.fail(`${message}: ${difference.changed} differing RGBA pixels at ${difference.size}; max channel delta=${difference.maxChannelDelta}; first=${JSON.stringify(difference.first)}; diagnostics=${JSON.stringify(diagnostics)}`);
}
