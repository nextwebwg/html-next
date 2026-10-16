import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, createApplication, startApplication } from "../src/index.js";
import { fixture, write } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const hash = (script: string) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
/** The fixture's app/head.js. */
const prepaint = "document.documentElement.dataset.prepaint = String(document.body === null);";
/** A page's <meta http-equiv> policy, decoded. */
const meta = (html: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1]?.replaceAll("&quot;", '"').replaceAll("&amp;", "&");

/** The fixture plus a checkout page that declares a payment provider's script, and a server-rendered page. */
async function app(): Promise<string> {
  const root = await fixture();
  roots.push(root);
  await write(root, "app/pages/checkout.html", `<template component="checkout-page"><defs><title>Checkout</title>
    <link rel="preconnect" href="https://js.pay.example"><script name="pay" src="https://js.pay.example/v3/" loading="lazy"></script></defs>
    <form><p $if="$pay.pending">Loading the payment form</p><button>Pay</button></form></template>`);
  await write(root, "app/pages/account.html", '<template component="account-page"><defs><meta name="hk:render" content="server"><title>Account</title>' +
    '<script src="https://maps.example/sdk.js"></script></defs><p>Account</p></template>');
  return root;
}

describe("the generated Content Security Policy", () => {
  it("allows every declared script origin of the site on every page, and hashes the head scripts", async () => {
    const root = await app();
    const { outDir } = await buildApplication({ root, headScript: "window.theme = 'dark';" });
    // The checkout page's payment script and the server-rendered account page's maps script, on every page.
    const policy = `script-src 'self' https://js.pay.example https://maps.example ${hash("window.theme = 'dark';")} ${hash(prepaint)}; object-src 'none'; base-uri 'none'`;
    const home = await readFile(join(outDir, "index.html"), "utf8");
    expect(meta(home)).toBe(policy);
    // The policy precedes every script it governs.
    expect(home.indexOf("Content-Security-Policy")).toBeLessThan(home.indexOf("<script"));
    for (const file of ["checkout/index.html", "items/one/index.html", "404.html"]) expect(meta(await readFile(join(outDir, file), "utf8"))).toBe(policy);
  }, 60_000);

  it("adds the csp option's sources to each directive, never replacing the generated ones", async () => {
    const root = await app();
    const csp = { "script-src": ["https://cdn.example/", "'self'"], "connect-src": ["https://api.example"], "object-src": ["https://plugins.example"],
      "frame-ancestors": ["'none'"] };
    const application = await createApplication({ root, csp });
    try {
      const page = await application.render("/checkout/");
      expect(page.head.csp).toEqual({ reportOnly: false,
        header: `script-src 'self' https://js.pay.example https://maps.example ${hash(prepaint)} https://cdn.example/; object-src https://plugins.example; base-uri 'none'; connect-src https://api.example; frame-ancestors 'none'`,
        // A meta element can't carry frame-ancestors, report-uri, or sandbox.
        meta: `script-src 'self' https://js.pay.example https://maps.example ${hash(prepaint)} https://cdn.example/; object-src https://plugins.example; base-uri 'none'; connect-src https://api.example` });
      expect(meta(page.html)).toBe(page.head.csp!.meta);
      const response = await application.fetch(new Request("http://localhost/checkout/"));
      expect(response.headers.get("content-security-policy")).toBe(page.head.csp!.header);
    } finally { await application.close(); }
    for (const invalid of [{ "script-src": "https://cdn.example" }, { "script-src": ["https://a.example https://b.example"] }, { "Script-Src": ["'self'"] },
      { "script-src": ["'self';"] }, { reportOnly: "yes" }]) {
      await expect(createApplication({ root, csp: invalid as never })).rejects.toThrow(/^csp/);
    }
  }, 60_000);

  it("reports only, through the header, with reportOnly, and is off with csp: false", async () => {
    const root = await app();
    const reporting = await createApplication({ root, csp: { reportOnly: true, "report-uri": ["/csp-reports"] } });
    try {
      const response = await reporting.fetch(new Request("http://localhost/"));
      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(response.headers.get("content-security-policy-report-only")).toBe(`script-src 'self' https://js.pay.example https://maps.example ${hash(prepaint)}; object-src 'none'; base-uri 'none'; report-uri /csp-reports`);
      // A meta element can't report only, so the page carries none.
      expect(meta(await response.text())).toBeUndefined();
    } finally { await reporting.close(); }
    const { outDir } = await buildApplication({ root, csp: false });
    for (const file of ["index.html", "checkout/index.html", "404.html"]) expect(await readFile(join(outDir, file), "utf8")).not.toContain("Content-Security-Policy");
    const off = await createApplication({ root, csp: false });
    try { expect((await off.fetch(new Request("http://localhost/checkout/"))).headers.get("content-security-policy")).toBeNull(); }
    finally { await off.close(); }
  }, 60_000);

  it("sends the site's policy as a header from htmlkit start, header-only directives included", async () => {
    const root = await app();
    const { outDir } = await buildApplication({ root, csp: { "frame-ancestors": ["'self'"] } });
    const server = await startApplication({ outDir, port: 0 });
    try {
      const policy = async (path: string) => (await fetch(server.url + path)).headers.get("content-security-policy");
      const home = await readFile(join(outDir, "index.html"), "utf8");
      expect(await policy("")).toBe(`${meta(home)}; frame-ancestors 'self'`);
      // Prerendered, server-rendered, and not-found pages all carry the one policy.
      expect(await policy("checkout/")).toBe(`${meta(home)}; frame-ancestors 'self'`);
      expect(await policy("account/")).toBe(`${meta(home)}; frame-ancestors 'self'`);
      expect(await policy("missing/")).toBe(`${meta(home)}; frame-ancestors 'self'`);
      expect(await policy("mark.svg")).toBeNull();
    } finally { await server.close(); }
    // Another output, since Node keeps the first server entry it imports.
    const reporting = await buildApplication({ root, outDir: join(root, "reporting"), csp: { reportOnly: true } });
    const reportOnly = await startApplication({ outDir: reporting.outDir, port: 0 });
    try {
      const response = await fetch(reportOnly.url + "checkout/");
      expect([response.headers.get("content-security-policy"), response.headers.get("content-security-policy-report-only")])
        .toEqual([null, `script-src 'self' https://js.pay.example https://maps.example ${hash(prepaint)}; object-src 'none'; base-uri 'none'`]);
    } finally { await reportOnly.close(); }
  }, 120_000);
});
