import assert from "node:assert/strict";

import type { Browser, BrowserType, Page } from "playwright";

/** Use one text raster path for both pages in Chromium's cross-page pixel comparisons. */
export function launchParityBrowser(browserType: BrowserType): Promise<Browser> {
  return browserType.launch({ headless: true, ...(browserType.name() === "chromium" ? { args: ["--disable-lcd-text"] } : {}) });
}

interface PixelDifference {
  readonly size: string;
  readonly changed: number;
  readonly first: { readonly x: number; readonly y: number; readonly actual: number[]; readonly expected: number[] } | null;
}

async function pixelDifference(page: Page, actual: Buffer, expected: Buffer): Promise<PixelDifference> {
  if (actual.equals(expected)) return { size: "same PNG", changed: 0, first: null };
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
}

async function diagnosePixelMismatch(actualPage: Page, expectedPage: Page | undefined, actual: Buffer, expected: Buffer): Promise<unknown> {
  const state = async (page: Page) => page.evaluate(() => {
    const button = document.querySelector("#case button");
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
export async function assertPixelsEqual(page: Page, actual: Buffer, expected: Buffer, message: string, expectedPage?: Page): Promise<void> {
  const difference = await pixelDifference(page, actual, expected);
  if (difference.changed === 0) return;
  let diagnostics: unknown;
  try { diagnostics = await diagnosePixelMismatch(page, expectedPage, actual, expected); }
  catch (error) { diagnostics = { error: String(error) }; }
  assert.fail(`${message}: ${difference.changed} differing RGBA pixels at ${difference.size}; first=${JSON.stringify(difference.first)}; diagnostics=${JSON.stringify(diagnostics)}`);
}
