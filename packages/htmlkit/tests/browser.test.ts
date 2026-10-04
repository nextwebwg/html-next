import { rm } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApplication, devApplication, previewApplication, type ApplicationServer } from "../src/index.js";
import { buildDocsProof } from "../examples/docs/proof.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./fixture.js";

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("built application adoption", () => {
  let root: string;
  let server: ApplicationServer;
  beforeAll(async () => {
    root = await fixture();
    await buildApplication({ root, base: "/kit/" });
    server = await previewApplication({ root, port: 0 });
  });
  afterAll(async () => { await server?.close(); if (root) await rm(root, { recursive: true, force: true }); });
  for (const [name, type] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    it(`${name} retains server DOM and edits, connects once, and balances reconnection`, async () => {
      const browser = await type.launch({ headless: true });
      try {
        const staticContext = await browser.newContext({ javaScriptEnabled: false });
        const staticPage = await staticContext.newPage();
        await staticPage.goto(server.url);
        expect(await staticPage.title()).toBe("Home & kit");
        expect(await staticPage.locator('head meta[name="description"]').getAttribute("content")).toBe("/kit/mark.svg");
        expect(await staticPage.locator('[data-component="home-label"]').evaluate(element => getComputedStyle(element).color)).toBe("rgb(90, 80, 70)");
        expect(await staticPage.locator('[data-component="home-page"]').evaluate(element => getComputedStyle(element).borderTopColor)).toBe("rgb(10, 20, 30)");
        expect(await staticPage.locator("output").textContent()).toBe("4");
        expect(await staticPage.getByText("Loading data", { exact: true }).count()).toBe(1);
        expect(await staticPage.locator("main").evaluate(element => getComputedStyle(element).color)).toBe("rgb(20, 30, 40)");
        expect(await staticPage.locator("button").evaluate(element => getComputedStyle(element).borderTopColor)).toBe("rgb(55, 66, 77)");
        const image = await staticPage.locator("main").evaluate(element => getComputedStyle(element).backgroundImage);
        expect(image).toContain("/kit/_htmlkit/");
        expect((await fetch(image.slice(5, -2))).status).toBe(200);
        await staticPage.goto(server.url + "items/two/");
        expect(await staticPage.locator("h1").textContent()).toBe("kit: two");

        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        let release!: () => void;
        let released = false;
        const gate = new Promise<void>(done => { release = done; });
        await page.route("**/_htmlkit/*.js", async route => { if (!released) await gate; await route.continue(); });
        await page.goto(server.url, { waitUntil: "commit" });
        await page.locator("input").waitFor();
        await page.evaluate(() => {
          const root = document.querySelector('[data-component="home-page"]')!;
          const input = root.querySelector("input")!;
          Object.assign(window, { originalRoot: root, originalInput: input, originalNodes: [...root.querySelectorAll("button, output, input")] });
          input.value = "edited before startup"; input.focus(); input.setSelectionRange(2, 8);
        });
        expect(await page.locator("output").textContent()).toBe("4");
        released = true; release();
        const subject = page.locator('[data-component="home-page"]');
        await expect.poll(() => subject.getAttribute("data-connections")).toBe("1");
        await page.getByText("Loaded data", { exact: true }).waitFor();
        expect(await subject.getAttribute("data-production")).toBe("true");
        expect(await page.locator("input").inputValue()).toBe("edited before startup");
        expect(await page.evaluate(() => {
          const saved = window as unknown as { originalRoot: Element; originalInput: HTMLInputElement; originalNodes: Element[] };
          const root = document.querySelector('[data-component="home-page"]')!;
          return root === saved.originalRoot && saved.originalNodes.every(node => root.contains(node)) &&
            document.activeElement === saved.originalInput && saved.originalInput.selectionStart === 2 && saved.originalInput.selectionEnd === 8;
        })).toBe(true);
        await page.locator("button").click();
        await expect.poll(() => page.locator("output").textContent()).toBe("5");
        await page.evaluate(async () => {
          const root = document.querySelector('[data-component="home-page"]')!;
          root.remove(); await new Promise(done => setTimeout(done, 0));
          root.querySelector<HTMLButtonElement>("button")!.click();
          document.querySelector("main")!.append(root);
        });
        await expect.poll(() => subject.getAttribute("data-connections")).toBe("2");
        expect(await page.locator("output").textContent()).toBe("5");
        await page.locator("button").click();
        await expect.poll(() => page.locator("output").textContent()).toBe("6");
        expect(errors).toEqual([]);
      } finally { await browser.close(); }
    });
  }
});

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("development and documentation consumers", () => {
  it("serves working development browser modules at a deployment subpath", async () => {
    const root = await fixture();
    const server = await devApplication({ root, base: "/development/", port: 0 });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(server.url);
      const subject = page.locator('[data-component="home-page"]');
      await expect.poll(() => subject.getAttribute("data-connections")).toBe("1");
      await page.getByText("Loaded data", { exact: true }).waitFor();
      expect(await subject.getAttribute("data-production")).toBe("false");
      expect(await page.locator("img").evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
      await page.locator("button").click();
      await expect.poll(() => page.locator("output").textContent()).toBe("5");
      expect(errors).toEqual([]);
    } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("delivers the documentation theme, search, and live example through the platform", async () => {
    const root = await mkdtemp(join(tmpdir(), "htmlkit-docs-browser-"));
    const browser = await chromium.launch({ headless: true });
    let server: ApplicationServer | undefined;
    try {
      await buildDocsProof(root, fileURLToPath(new URL("../../../docs/guide", import.meta.url)), "/proof/");
      server = await previewApplication({ root, port: 0 });
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(server.url + "reference/counter/");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("button", { name: "Increment", exact: true }).click();
      await expect.poll(() => page.locator("output").textContent()).toBe("2");
      await page.getByRole("button", { name: "Toggle theme" }).click();
      await expect.poll(() => page.locator('[data-component="proof-shell"]').evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(20, 38, 56)");
      await page.getByRole("searchbox").fill("quick-start");
      await expect.poll(() => page.locator("nav li:visible").count()).toBe(1);
      await page.getByRole("link", { name: "quick-start", exact: true }).click();
      expect(page.url()).toContain("/proof/guide/quick-start/");
      expect(errors).toEqual([]);
    } finally { await browser.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});
