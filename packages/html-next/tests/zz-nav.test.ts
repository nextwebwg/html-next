import { readFileSync, appendFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { it, vi } from "vitest";
import { parseComponent } from "../src/source-parser.js";
import { compiledFixtures } from "./hydration-fixtures.js";
const log = (...parts: unknown[]) => appendFileSync("/private/tmp/claude-501/-Users-matthew-git-worktrees-html-next-youthful-torvalds-8d4f7d/7d47545a-62a3-47bf-9976-4fbeb4364ebe/scratchpad/zz.log", parts.join(" ") + "\n");
it("debug", async () => {
  const nav = parseComponent(readFileSync(new URL("../../htmlkit/components/nav.html", import.meta.url), "utf8"));
  const shell = parseComponent(`<template component="x-shell"><defs><prop name="navigation" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string }))" required>L</prop></defs>
    <div><hk-nav from:items="$navigation" label="Site"></hk-nav><slot name="page"></slot></div></template>`);
  for (const hydrate of [true, false]) {
    const code = await compiledFixtures("esm", "", [shell, nav], {}, hydrate);
    const { window } = new JSDOM("<!doctype html><body></body>");
    for (const key of Object.getOwnPropertyNames(window)) { if (key in globalThis && !["Event", "CustomEvent", "EventTarget", "document", "Node", "Element"].includes(key)) continue; try { vi.stubGlobal(key, (window as any)[key]); } catch {} }
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(code + "\n//" + Math.random()).toString("base64")}`);
    const root = runtime.factories["x-shell"]({ attributes: { id: "hk-layer-0" } }, { navigation: JSON.stringify([{ href: "/", label: "Home", current: "page", depth: 0, pageName: "p" }]) });
    window.document.body.append(root);
    await new Promise((r) => setTimeout(r, 0));
    log("hydrate", hydrate, root.outerHTML);
    vi.unstubAllGlobals();
  }
});
