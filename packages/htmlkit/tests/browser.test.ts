import { readFile, rm } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApplication, devApplication, previewApplication, startApplication, type ApplicationServer } from "../src/index.js";
import { buildDocsProof } from "../examples/docs/proof.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { bindingFixture, environmentFixture, fixture, privateFixture, preparedFixture, retainedProviderFixture, universalFixture, write } from "./fixture.js";

for (const [delivery, commonJS] of [["development", false], ["built", false], ["development", true]] as const) {
  describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${delivery} prepared library module${commonJS ? " with CommonJS dependency" : ""}`, () => {
    it("Chromium adopts the server value without another read and keeps drafts through later updates", async () => {
      const root = await preparedFixture(commonJS);
      let server: ApplicationServer | undefined;
      const browser = await chromium.launch({ headless: true });
      try {
        server = delivery === "built"
          ? await startApplication({ outDir: (await buildApplication({ root })).outDir, port: 0 })
          : await devApplication({ root, port: 0 });
        const page = await browser.newPage(); const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(() => {
          const observer = new MutationObserver(() => {
            const heading = document.querySelector("h1");
            if (heading) { Reflect.set(window, "originalHeading", heading); observer.disconnect(); }
          });
          observer.observe(document, { childList: true, subtree: true });
        });
        await page.goto(server.url);
        await page.waitForFunction(() => document.querySelector("main")?.dataset.connected === "true");
        expect(await page.locator("h1").textContent()).toBe("build:A");
        expect(await page.evaluate(() => Reflect.get(window, "originalHeading") === document.querySelector("h1"))).toBe(true);
        expect(await page.evaluate(() => Reflect.get(window, "preparedReads"))).toBeUndefined();
        await page.locator("input").fill("My draft");
        await page.getByRole("button", { name: "Next" }).click();
        await expect.poll(() => page.locator("h1").textContent()).toBe("browser:B");
        expect(await page.locator("input").inputValue()).toBe("My draft");
        expect(await page.evaluate(() => Reflect.get(window, "preparedReads"))).toEqual(["B"]);
        await page.getByRole("link", { name: "Fixture" }).click();
        await expect.poll(() => page.locator("h1").textContent()).toBe("Caller");
        expect(await page.evaluate(() => Reflect.get(window, "preparedReads"))).toEqual(["B"]);
        expect(errors).toEqual([]);
      } finally { await browser.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
    });
  });
}

for (const delegated of [false, true]) for (const delivery of ["development", "built"] as const) {
  describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${delivery} ${delegated ? "delegated " : ""}retained layout providers`, () => {
    let root: string; let server: ApplicationServer; const requests: string[] = [];
    beforeAll(async () => {
      root = await retainedProviderFixture(delegated);
      const services = { read(id: string, { phase }: { phase: string }) {
        if (phase === "request") requests.push(id);
        return phase + ":" + id;
      } };
      if (delivery === "built") server = await startApplication({ outDir: (await buildApplication({ root, services })).outDir, services, port: 0 });
      else server = await devApplication({ root, services, port: 0 });
    });
    afterAll(async () => { await server?.close(); if (root) await rm(root, { recursive: true, force: true }); });
    for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
      it(`${name} adopts fresh layout preparation while keeping drafts and instance identity`, async () => {
        requests.length = 0;
        const browser = await engine.launch({ headless: true });
        try {
          const page = await browser.newPage(); let reads = 0; const errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          page.on("request", request => { if (new URL(request.url()).pathname === "/_htmlkit/read") reads += 1; });
          expect(await (await fetch(server.url)).text()).toContain(">build:A</h2>");
          await page.goto(server.url);
          await page.waitForLoadState("networkidle");
          expect(errors).toEqual([]);
          await expect.poll(() => page.locator("main").getAttribute("data-connections")).toBe("1");
          expect(await page.locator("h2").textContent()).toBe("build:A");
          await page.evaluate(() => Reflect.set(window, "retainedShell", document.querySelector("main")));
          await page.getByRole("textbox", { name: "Draft" }).fill("Edited");
          await page.getByRole("link", { name: "Second", exact: true }).click();
          await page.getByRole("heading", { name: "Second", exact: true }).waitFor();
          await expect.poll(() => page.locator("main").textContent()).toContain("build:B");
          expect(await page.getByRole("textbox", { name: "Draft" }).inputValue()).toBe("Edited");
          expect(await page.evaluate(() => Reflect.get(window, "retainedShell") === document.querySelector("main"))).toBe(true);
          expect(await page.evaluate(() => Reflect.get(window, "retainedCreates"))).toBe(1);
          expect(reads).toBe(0);
          expect(requests).toEqual([]);
          await page.getByRole("link", { name: "First", exact: true }).click();
          await page.getByRole("heading", { name: "First", exact: true }).waitFor();
          await expect.poll(() => page.locator("h2").textContent()).toBe("build:A");
          await page.getByRole("button", { name: "Refresh", exact: true }).click();
          await expect.poll(() => page.locator("h2").textContent()).toBe("request:A");
          await page.getByRole("link", { name: "Same input", exact: true }).click();
          await page.getByRole("heading", { name: "Same input", exact: true }).waitFor();
          expect(await page.locator("h2").textContent()).toBe("request:A");
          expect(await page.getByRole("textbox", { name: "Draft" }).inputValue()).toBe("Edited");
          expect(await page.evaluate(() => Reflect.get(window, "retainedCreates"))).toBe(1);
          expect(await page.locator("main").getAttribute("data-connections")).toBe("1");
          expect(reads).toBe(1);
          expect(requests).toEqual(["A"]);
        } finally { await browser.close(); }
      });
    }
  });
}

for (const delivery of ["development", "built"] as const) {
  describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${delivery} private component readers`, () => {
    let root: string; let server: ApplicationServer; const calls: string[] = [];
    beforeAll(async () => {
      root = await privateFixture();
      await rm(join(root, "app/pages/index.client.ts"));
      const source = await readFile(join(root, "app/pages/index.html"), "utf8");
      await write(root, "app/pages/override.html", source.replace('component="client-page"', 'component="private-override-page"'));
      await write(root, "app/pages/override.ts", 'export * from "./index.ts";');
      await write(root, "app/pages/override.server.ts", 'export * from "./index.server.ts";');
      await write(root, "app/pages/override.client.ts", 'export const props = { label: { load: query => "client:" + query } };');
      await write(root, "app/pages/typed.html", `<template component="private-typed-page"><defs><meta name="hk:layout" content="none">
        <state name="mode" type="keyword" values="text, number" value="number"></state><state name="query" type="number" value="1"></state>
        <prop name="label">Result.<type from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
        <handler name="next"><set name="query" value="2"></set></handler></defs><main>
        <h1 $await="$label">{$label}</h1><p $error="problem">{$problem.message}</p><p $else>Waiting.</p><button on:click="next">Next</button></main></template>`);
      await write(root, "app/pages/typed.ts", 'export const props = { label: { input: (_, { state }) => state.query } };');
      await write(root, "app/pages/typed.server.ts", 'export const props = { label: { load: query => query } };');
      const services = { read(query: string, context: { phase: string; cookies: ReadonlyMap<string, string> }) {
        calls.push(context.phase + ":" + query);
        if (context.phase === "request" && !context.cookies.has("user")) throw new Response("Sign in", { status: 403 });
        return context.phase + ":" + query;
      } };
      if (delivery === "built") {
        const { outDir } = await buildApplication({ root, services, base: "/private/" });
        server = await startApplication({ outDir, services, port: 0 });
      } else server = await devApplication({ root, services, base: "/private/", port: 0 });
    });
    afterAll(async () => { await server?.close(); if (root) await rm(root, { recursive: true, force: true }); });
    for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
      it(`${name} adopts private preparation and uses fresh authenticated requests for changes`, async () => {
        const browser = await engine.launch({ headless: true });
        try {
          const unscripted = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
          await unscripted.goto(server.url);
          expect(await unscripted.locator("h1").textContent()).toBe("build:A");
          const context = await browser.newContext();
          await context.addCookies([{ name: "user", value: "Ada", url: server.url }]);
          const page = await context.newPage(); const errors: string[] = []; let requests = 0;
          page.on("pageerror", error => errors.push(error.message));
          page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/_htmlkit/read")) requests += 1; });
          await page.goto(server.url);
          await page.waitForFunction(() => document.querySelector("main")?.dataset.commonConnections === "1");
          expect(await page.locator("h1").textContent()).toBe("build:A");
          expect(requests).toBe(0);
          await page.locator("input").fill("Edited");
          await page.getByRole("button", { name: "Next" }).click();
          await expect.poll(() => page.locator("h1").textContent()).toBe("request:B");
          expect(await page.locator("input").inputValue()).toBe("Edited");
          expect(requests).toBe(1);
          await page.goto(server.url + "fixture/");
          await page.waitForFunction(() => document.querySelector("main")?.dataset.commonConnections === "1");
          expect(await page.locator("h1").textContent()).toBe("Fixture");
          expect(requests).toBe(1);
          await page.goto(server.url + "override/");
          await page.waitForFunction(() => document.querySelector("main")?.dataset.commonConnections === "1");
          expect(await page.locator("h1").textContent()).toBe("build:A");
          await page.getByRole("button", { name: "Next" }).click();
          await expect.poll(() => page.locator("h1").textContent()).toBe("client:B");
          expect(requests).toBe(1);
          await page.goto(server.url + "live/?q=C");
          await page.waitForFunction(() => document.querySelector("main")?.dataset.commonConnections === "1");
          expect(await page.locator("h1").textContent()).toBe("request:C");
          expect(requests).toBe(1);
          await context.clearCookies();
          await page.getByRole("button", { name: "Next" }).click();
          await expect.poll(() => page.getByText("Sign in", { exact: true }).count()).toBe(1);
          expect(requests).toBe(2);
          expect(await (await fetch(server.url + "typed/")).text()).toContain(">1</h1>");
          await page.goto(server.url + "typed/");
          await expect.poll(() => page.locator("h1").textContent()).toBe("1");
          await page.getByRole("button", { name: "Next" }).click();
          await expect.poll(() => page.locator("h1").textContent()).toBe("2");
          expect(requests).toBe(3);
          expect(calls).toContain("request:B");
          expect(errors).toEqual([]);
        } finally { await browser.close(); }
      });
    }
  });
}

for (const delivery of ["development", "built"] as const) {
  describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${delivery} client companion modules`, () => {
    let root: string; let server: ApplicationServer;
    beforeAll(async () => {
      root = await environmentFixture();
      if (delivery === "built") {
        const { outDir } = await buildApplication({ root });
        server = await startApplication({ outDir, port: 0 });
      } else server = await devApplication({ root, port: 0 });
    });
    afterAll(async () => { await server?.close(); if (root) await rm(root, { recursive: true, force: true }); });
    for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
      it(`${name} composes browser readers and behavior with retained instance ownership`, async () => {
        const browser = await engine.launch({ headless: true });
        try {
          const unscripted = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
          await unscripted.goto(server.url);
          expect(await unscripted.getByText("Waiting.", { exact: true }).count()).toBe(1);
          const page = await browser.newPage(); const errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          await page.goto(server.url);
          await expect.poll(() => page.locator("h1").textContent()).toBe("browser:A");
          await page.waitForFunction(() => document.querySelector("main")?.dataset.clientConnections === "1");
          expect(await page.locator("main").getAttribute("data-common-connections")).toBe("1");
          expect(await page.evaluate(() => Reflect.get(window, "environmentCreates"))).toBe(1);
          await page.locator("input").fill("Edited");
          await page.getByRole("button", { name: "Next" }).click();
          await expect.poll(() => page.locator("h1").textContent()).toBe("browser:B");
          expect(await page.locator("input").inputValue()).toBe("Edited");
          await page.evaluate(() => { const root = document.querySelector("main")!; Reflect.set(window, "clientRoot", root); root.remove(); });
          await expect.poll(() => page.evaluate(() => Reflect.get(window, "environmentHooks"))).toEqual(["common-connect", "client-connect", "client-stop", "common-stop"]);
          await page.evaluate(() => document.body.prepend(Reflect.get(window, "clientRoot")));
          await page.waitForFunction(() => document.querySelector("main")?.dataset.clientConnections === "2");
          expect(await page.locator("main").getAttribute("data-common-connections")).toBe("2");
          expect(await page.evaluate(() => Reflect.get(window, "environmentCreates"))).toBe(1);
          expect(await page.evaluate(() => Reflect.get(window, "environmentReads"))).toEqual(["A", "B"]);
          expect(await page.locator("input").inputValue()).toBe("Edited");
          await page.goto(server.url + "mixed/");
          await page.waitForFunction(() => document.querySelector("main")?.dataset.mixed === "connected");
          expect(await page.locator("h1").textContent()).toBe("build:A");
          expect(await page.evaluate(() => Reflect.get(window, "mixedReads"))).toBeUndefined();
          await page.getByRole("button", { name: "Next" }).click();
          await expect.poll(() => page.locator("h1").textContent()).toBe("client:B");
          expect(await page.evaluate(() => Reflect.get(window, "mixedReads"))).toEqual(["B"]);
          await page.goto(server.url + "only/");
          await expect.poll(() => page.locator("h1").textContent()).toBe("only:A");
          await page.goto(server.url + "fixture/");
          await page.waitForFunction(() => document.querySelector("main")?.dataset.clientConnections === "1");
          expect(await page.locator("h1").textContent()).toBe("Fixture");
          expect(await page.evaluate(() => Reflect.get(window, "environmentReads"))).toBeUndefined();
          await page.goto(server.url + "live/?q=C");
          await expect.poll(() => page.locator("h1").textContent()).toBe("browser:C");
          expect(errors).toEqual([]);
        } finally { await browser.close(); }
      });
    }
  });
}

for (const delivery of ["development", "built"] as const) {
  describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${delivery} universal component providers`, () => {
    let root: string;
    let server: ApplicationServer;
    beforeAll(async () => {
      root = await universalFixture();
      if (delivery === "built") {
        const result = await buildApplication({ root });
        server = await startApplication({ outDir: result.outDir, port: 0 });
      } else server = await devApplication({ root, port: 0 });
    });
    afterAll(async () => { await server?.close(); if (root) await rm(root, { recursive: true, force: true }); });
    for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
      it(`${name} adopts prepared data once, retains drafts and renders fresh navigations from their preparation`, async () => {
        const browser = await engine.launch({ headless: true });
        try {
          const unscripted = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
          await unscripted.goto(server.url);
          expect(await unscripted.locator("h1").textContent()).toBe("build:A");
          expect(await unscripted.title()).toBe("Product build:A");
          const page = await browser.newPage(); const errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          await page.goto(server.url);
          await page.waitForFunction(() => document.querySelector("main")?.dataset.connections === "1");
          expect(await page.locator("h1").textContent()).toBe("build:A");
          expect(await page.locator("input").inputValue()).toBe("build:A");
          expect(await page.evaluate(() => Reflect.get(window, "universalReads"))).toBeUndefined();
          expect(await page.locator(".details").textContent()).toBe("build:details:build:A");
          expect(await page.evaluate(() => Reflect.get(window, "detailReads"))).toBeUndefined();
          await page.evaluate(() => Reflect.set(window, "detailsRoot", document.querySelector('[data-component="product-details"]')));
          await page.locator("input").fill("Edited");
          await page.getByRole("button", { name: "Next" }).click();
          await expect.poll(() => page.locator("h1").textContent()).toBe("browser:B");
          expect(await page.locator("input").inputValue()).toBe("Edited");
          expect(await page.evaluate(() => Reflect.get(window, "universalReads"))).toEqual(["B"]);
          await expect.poll(() => page.locator(".details").textContent()).toBe("browser:details:browser:B");
          expect(await page.locator(".details-draft").textContent()).toBe("build:details:build:A");
          expect(await page.evaluate(() => Reflect.get(window, "detailsRoot") === document.querySelector('[data-component="product-details"]'))).toBe(true);
          expect(await page.evaluate(() => Reflect.get(window, "detailReads"))).toEqual(["browser:B"]);
          await page.goto(server.url + "live/?q=C");
          await page.waitForFunction(() => document.querySelector("main")?.dataset.connections === "1");
          expect(await page.locator("h1").textContent()).toBe("request:C");
          expect(await page.evaluate(() => Reflect.get(window, "universalReads"))).toBeUndefined();
          await page.goto(server.url + "fixture/");
          await page.waitForFunction(() => document.querySelector("main")?.dataset.connections === "1");
          expect(await page.locator("h1").textContent()).toBe("Fixture");
          expect(await page.evaluate(() => Reflect.get(window, "universalReads"))).toBeUndefined();
          const payload = await (await fetch(server.url + "_htmlkit/pages/payload.json")).json();
          expect(payload.rendered.body).toContain("<h1>build:A</h1>");
          await page.evaluate(() => Reflect.set(window, "universalMarker", true));
          await page.getByRole("link", { name: "Home", exact: true }).click();
          await expect.poll(() => page.locator("h1").textContent()).toBe("build:A");
          expect(await page.evaluate(() => Reflect.get(window, "universalMarker"))).toBe(true);
          expect(await page.evaluate(() => Reflect.get(window, "universalReads"))).toBeUndefined();
          await page.goto(server.url + "delegated/");
          await page.waitForFunction(() => document.querySelector("main")?.dataset.connections === "1");
          expect(await page.locator("h1").textContent()).toBe("build:A");
          expect(await page.locator(".shell-label").textContent()).toBe("build:shell");
          expect(await page.evaluate(() => Reflect.get(window, "universalReads"))).toBeUndefined();
          await unscripted.goto(server.url + "deferred/");
          expect(await unscripted.getByText("Waiting.", { exact: true }).count()).toBe(1);
          await page.addInitScript(() => { Reflect.set(window, "holdUniversal", true); });
          await page.goto(server.url + "deferred/");
          await page.waitForFunction(() => typeof Reflect.get(window, "releaseUniversal") === "function");
          expect(await page.getByText("Waiting.", { exact: true }).count()).toBe(1);
          expect(await page.locator("main").evaluate(element => Reflect.get(element, "validity").valueMissing)).toBe(true);
          await page.locator("input").fill("Early draft");
          await page.evaluate(() => Reflect.get(window, "releaseUniversal")());
          await expect.poll(() => page.locator("h1").textContent()).toBe("browser:A");
          expect(await page.locator("input").inputValue()).toBe("Early draft");
          expect(await page.locator("main").evaluate(element => Reflect.get(element, "validity").valid)).toBe(true);
          expect(await page.evaluate(() => Reflect.get(window, "universalReads"))).toEqual(["A"]);
          await expect.poll(() => page.locator(".details").textContent()).toBe("browser:details:browser:A");
          expect(await page.evaluate(() => Reflect.get(window, "detailReads"))).toEqual(["browser:A"]);
          expect(errors).toEqual([]);
        } finally { await browser.close(); }
      });
    }
  });
}

for (const delivery of ["development", "built"] as const) {
  describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")(`${delivery} component provider modules`, () => {
    let root: string;
    let server: ApplicationServer;
    beforeAll(async () => {
      root = await bindingFixture();
      if (delivery === "built") await buildApplication({ root, base: "/bindings/" });
      server = await (delivery === "built" ? previewApplication : devApplication)({ root, base: "/bindings/", port: 0 });
    });
    afterAll(async () => { await server?.close(); if (root) await rm(root, { recursive: true, force: true }); });
    for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
      it(`${name} binds providers, bypasses fixtures and retains local drafts across reconnection`, async () => {
        const browser = await engine.launch({ headless: true });
        try {
          const unscripted = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
          await unscripted.goto(server.url);
          expect(await unscripted.getByText("Waiting.", { exact: true }).count()).toBe(1);
          expect(await unscripted.locator("h2").allTextContents()).toEqual(["Fixture"]);
          await unscripted.goto(server.url + "defaults/");
          expect(await unscripted.locator("h1").textContent()).toBe("Default");
          expect(await unscripted.locator(".nullable").textContent()).toBe("");
          expect(await unscripted.locator(".count").textContent()).toBe("0");
          const page = await browser.newPage(); const errors: string[] = [];
          page.setDefaultTimeout(5_000);
          page.on("pageerror", error => errors.push(error.message));
          await page.goto(server.url);
          const cards = page.locator('[data-component="binding-card"]');
          await expect.poll(() => cards.first().locator("h2").textContent()).toBe("Product A");
          await expect.poll(() => page.locator('[data-component="binding-label"] output').textContent()).toBe("Label only");
          await expect.poll(() => page.locator('[data-component="plain-behavior"]').getAttribute("data-plain")).toBe("connected");
          expect(await cards.last().locator("h2").textContent()).toBe("Fixture");
          expect(await page.evaluate(() => Reflect.get(window, "bindingReads"))).toEqual(["A"]);
          await cards.first().locator("input").fill("Edited");
          await cards.first().locator("button").click();
          await expect.poll(() => cards.first().locator("h2").textContent()).toBe("Product B");
          expect(await cards.first().locator("input").inputValue()).toBe("Edited");
          await page.evaluate(() => { const subject = document.querySelector('[data-component="binding-card"]')!; Reflect.set(window, "bindingSubject", subject); subject.remove(); });
          await page.waitForFunction(() => Reflect.get(window, "bindingSubject").dataset.stops === "1");
          await page.evaluate(() => document.querySelector("main")!.prepend(Reflect.get(window, "bindingSubject")));
          await expect.poll(() => cards.first().getAttribute("data-connections")).toBe("2");
          expect(await cards.first().locator("input").inputValue()).toBe("Edited");
          expect(await page.evaluate(() => Reflect.get(window, "bindingReads"))).toEqual(["A", "B"]);
          // Fresh navigation and SSR adoption preserve caller ownership, including null with a default.
          await page.evaluate(() => Reflect.set(window, "navigationMarker", document.querySelector(".shell")));
          await page.getByRole("link", { name: "Default inputs" }).click();
          await expect.poll(() => page.locator("h1").textContent()).toBe("Provider");
          expect(await page.evaluate(() => Reflect.get(window, "navigationMarker") === document.querySelector(".shell"))).toBe(true);
          expect(await page.locator(".shell-value").textContent()).toBe("Shell");
          expect(await page.locator(".shell-draft").textContent()).toBe("First");
          expect(await page.locator(".nullable").textContent()).toBe("");
          expect(await page.locator(".count").textContent()).toBe("0");
          expect(await page.locator("input").inputValue()).toBe("Default");
          expect(await page.evaluate(() => Reflect.get(window, "defaultReads"))).toEqual(["label"]);
          await page.goto(server.url + "defaults/");
          await expect.poll(() => page.locator("h1").textContent()).toBe("Provider");
          expect(await page.locator(".nullable").textContent()).toBe("");
          expect(await page.locator(".count").textContent()).toBe("0");
          expect(await page.locator("input").inputValue()).toBe("Default");
          expect(await page.evaluate(() => Reflect.get(window, "defaultReads"))).toEqual(["label"]);
          expect(errors).toEqual([]);
        } finally { await browser.close(); }
      });
    }
  });
}

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("built application adoption", () => {
  let root: string;
  let server: ApplicationServer;
  let runtime: string;
  beforeAll(async () => {
    root = await fixture();
    await buildApplication({ root, base: "/kit/" });
    server = await previewApplication({ root, port: 0 });
    // The live runtime's API, as page code would import it, to read the compiled roots it did not create.
    const live = await build({ configFile: false, logLevel: "silent", build: { write: false, minify: false,
      lib: { entry: fileURLToPath(new URL("../../html-next/src/live.ts", import.meta.url)), formats: ["iife"], name: "HtmlRuntime" } } });
    runtime = (Array.isArray(live) ? live[0]! : live as { output: { code?: string }[] }).output[0]!.code!;
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
        expect(await page.evaluate(() => document.documentElement.dataset.prepaint)).toBe("true");
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
        // Test code outside the page's policy, which allows no inline script.
        await page.evaluate(runtime);
        expect(await page.evaluate(() => {
          const { getComponentHost } = (window as unknown as { HtmlRuntime: { getComponentHost(element: Element): { state: { count: number }; root: Element } | undefined } }).HtmlRuntime;
          const root = document.querySelector('[data-component="home-page"]')!;
          return { count: getComponentHost(root)?.state.count, root: getComponentHost(root)?.root === root };
        })).toEqual({ count: 5, root: true });
        await expect.poll(() => page.locator("button").getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator("button span").textContent()).toBe("5");
        expect(await page.locator("button").evaluate(element => element.classList.contains("active"))).toBe(true);
        expect(await page.locator("button").evaluate(element => (element as HTMLElement).style.opacity)).toBe("0.5");
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
      // Component stylesheets are document links, so they apply at first paint, before any module runs.
      const unscripted = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
      await unscripted.goto(server.url);
      expect(await unscripted.locator("main").evaluate(element => getComputedStyle(element).color)).toBe("rgb(20, 30, 40)");
      expect(await unscripted.locator('[data-component="home-label"]').evaluate(element => getComputedStyle(element).color)).toBe("rgb(90, 80, 70)");
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
      // An edited component reloads the page, whose regenerated modules adopt the new server DOM.
      await page.evaluate(() => { (window as unknown as { previous: boolean }).previous = true; });
      const source = await readFile(join(root, "app/pages/index.html"), "utf8");
      await write(root, "app/pages/index.html", source.replace("<h1>Home</h1>", "<h1>Edited home</h1>"));
      await page.waitForFunction(() => !(window as unknown as { previous?: boolean }).previous && document.querySelector("h1")?.textContent === "Edited home",
        undefined, { timeout: 10_000 });
      await expect.poll(() => subject.getAttribute("data-connections")).toBe("1");
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
      await page.evaluate(() => {
        const counter = document.querySelector('[data-component="proof-counter"]')!;
        Reflect.set(window, "retainedCounter", counter);
        Reflect.set(window, "retainedCounterParent", counter.parentElement);
        counter.remove();
      });
      await page.evaluate(() => Reflect.get(window, "retainedCounterParent").append(Reflect.get(window, "retainedCounter")));
      await page.getByRole("button", { name: "Increment", exact: true }).click();
      await expect.poll(() => page.locator("output").textContent()).toBe("4");
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

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("page-wide stylesheets", () => {
  it("apply on first paint in built and development pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "htmlkit-page-css-"));
    await write(root, "package.json", '{"type":"module"}');
    await write(root, "styles/page.css", "html { background: rgb(1, 2, 3); } body { margin: 0; }");
    await write(root, "app/pages/index.html", '<template component="page-home"><h1>Home</h1></template>');
    const options = { root, css: ["@/styles/page.css"] };
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
      const check = async () => expect(await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).marginTop]))
        .toEqual(["rgb(1, 2, 3)", "0px"]);
      await buildApplication(options);
      const preview = await previewApplication({ ...options, port: 0 });
      try { await page.goto(preview.url); await check(); } finally { await preview.close(); }
      const dev = await devApplication({ ...options, port: 0 });
      try { await page.goto(dev.url); await check(); } finally { await dev.close(); }
    } finally { await browser.close(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== "1")("the development policy", () => {
  for (const [name, type] of [["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]] as const) {
    it(`${name} reports each violation with the config line that allows it, and keeps Vite working`, async () => {
      const root = await fixture();
      await write(root, "app/pages/tracker.html", '<template component="tracker-page" controller="./tracker.ts"><defs><title>Tracker</title></defs><h1>Tracker</h1></template>');
      // A script no component declares, so the policy has no source for it.
      await write(root, "app/pages/tracker.ts", "export default function () { const script = document.createElement('script'); script.src = 'https://elsewhere.example/tracker.js'; document.head.append(script); }");
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Restricting connect-src and style-src, which Vite's HMR socket and injected styles need in development.
      const server = await devApplication({ root, port: 0, csp: { "connect-src": ["'self'"], "style-src": ["'self'"] } });
      const browser = await type.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const messages: string[] = [];
        page.on("console", message => { if (message.type() === "warning") messages.push(message.text()); });
        const line = 'To allow it, add to htmlkit.config.ts: csp: { "script-src": ["https://elsewhere.example"] }';
        await page.goto(server.url + "tracker/");
        await expect.poll(() => messages.find(message => message.includes(line)), { timeout: 10_000 })
          .toBe(`HTMLKit: /tracker/ blocked https://elsewhere.example/tracker.js under script-src. ${line}`);
        await expect.poll(() => warned.mock.calls.find(([message]) => String(message).includes(line))?.[0], { timeout: 10_000 })
          .toBe(`HTMLKit: /tracker/ blocked https://elsewhere.example/tracker.js under script-src. ${line}`);
        // Everything else works under the policy: the page's modules, a controller's imported CSS, and reloading after an edit.
        messages.length = 0;
        await page.goto(server.url);
        await expect.poll(() => page.locator('[data-component="home-page"]').getAttribute("data-connections")).toBe("1");
        await expect.poll(() => page.locator("button").first().evaluate(button => getComputedStyle(button).borderTopColor)).toBe("rgb(55, 66, 77)");
        await page.evaluate(() => { (window as unknown as { previous: boolean }).previous = true; });
        const source = await readFile(join(root, "app/pages/index.html"), "utf8");
        await write(root, "app/pages/index.html", source.replace("<h1>Home</h1>", "<h1>Edited home</h1>"));
        await page.waitForFunction(() => !(window as unknown as { previous?: boolean }).previous && document.querySelector("h1")?.textContent === "Edited home",
          undefined, { timeout: 10_000 });
        expect(messages.filter(message => message.startsWith("HTMLKit:"))).toEqual([]);
      } finally { warned.mockRestore(); await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
    }, 60_000);
  }
});
