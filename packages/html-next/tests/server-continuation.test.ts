import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";
import { chromium, firefox, webkit, type Page } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";

import { parseComponent } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";

const source = `<template component="ssr-connected" controller="./controller.js"><defs>
  <prop name="step" type="number" default="2">Increment.</prop>
  <state name="count" type="number" value="3"></state>
  <state name="query" type="number" value="1"></state>
  <state name="text" type="string" value="'initial'"></state>
  <state name="derived" type="number" value="0"></state>
  <data name="result" src="./data"><param name="query" from:value="query"></param></data>
  <method name="advance" export="advance" returns="promise(undefined)"></method>
  </defs><section><h2><slot name="title">Untitled</slot></h2><button $ref="button" type="button">Next</button>
  <output $ref="count" $value="count"></output><b $value="derived"></b><input bind:value="text" value="authored">
  <p $if="result.pending">Loading</p><div $if="result.ok" $value="result.value.label"></div><slot></slot>
  </section></template>`;
const authored = '<ssr-connected id="subject" step="2"><strong slot="title">Title</strong>Body</ssr-connected>';
const controller = `export default function(host) {
  host.root.dataset.connections = String(Number(host.root.dataset.connections || 0) + 1);
  const next = () => advance(host);
  host.refs.button.addEventListener('click', next);
  const stop = host.effect(() => { host.state.derived = host.state.count * host.props.step.value; });
  return () => { stop(); host.refs.button.removeEventListener('click', next); };
}
export function advance(host) { host.state.count += host.props.step.value; host.state.query += 1; }
`;

async function inspect(page: Page) {
  return page.evaluate(() => {
    const context = window as unknown as { Continuation: { inspectInstance(element: Element): unknown } };
    const root = document.querySelector('#subject')!;
    const clone = root.cloneNode(true) as Element;
    clone.removeAttribute('data-connections');
    return { instance: context.Continuation.inspectInstance(root), html: clone.outerHTML,
      connections: root.getAttribute('data-connections'), input: root.querySelector('input')!.value };
  });
}

// Real HTTP module and data loading; no mocked controller host or network boundary.
describe.skipIf(process.env.HTMLNEXT_BROWSER_TEST !== '1')('Node output continues through browser delivery', () => {
  let directory: string;
  let server: Server;
  let origin: string;
  let rendered: string;
  let liveBundle: string;
  let staticBundle: string;
  let baselineBundle: string;
  let dataRequests = 0;
  let controllerRequests = 0;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'html-next-continuation-'));
    server = createServer((request, response) => {
      const url = new URL(request.url!, origin);
      if (url.pathname === '/component.html') {
        response.setHeader('content-type', 'text/html');
        response.end(source);
      } else if (url.pathname === '/controller.js') {
        controllerRequests += 1;
        response.setHeader('content-type', 'text/javascript');
        response.end(controller);
      } else if (url.pathname === '/data') {
        dataRequests += 1;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ label: `Result ${url.searchParams.get('query')}` }));
      } else {
        response.setHeader('content-type', 'text/html');
        response.end(`<link rel="component" href="/component.html"><main>${url.pathname === '/hydrated' ? rendered : authored}</main>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    const definition = parseComponent(source, `${origin}/component.html`);
    const result = await renderComponents(authored, { definitions: [definition], url: `${origin}/hydrated` });
    rendered = result.html;
    assert.equal(dataRequests, 0, 'server rendering does not connect declared reads');
    assert.equal(controllerRequests, 0, 'controller first attaches at browser hydration');

    const runtime = new URL('../src/runtime.ts', import.meta.url).pathname;
    const loader = new URL('../src/browser-loader.ts', import.meta.url).pathname;
    const controllerFile = join(directory, 'controller.js');
    await writeFile(controllerFile, controller);
    const entries = {
      baseline: `import { registerComponentDefinitions, lowerDocument } from ${JSON.stringify(runtime)};
        export { lowerDocument, serializeRenderedForm } from ${JSON.stringify(runtime)};
        registerComponentDefinitions(${JSON.stringify([definition])});
        lowerDocument(document, { connect: false });`,
      live: `import { startBrowserComponents } from ${JSON.stringify(loader)};
        export { inspectInstance, updateComponentProps } from ${JSON.stringify(runtime)};
        export const ready = startBrowserComponents().then(value => { window.stopComponents = value.stop; });`,
      static: `import { registerComponentDefinitions, observeDocument, getComponentHost, setControllerModule } from ${JSON.stringify(runtime)};
        import * as controller from ${JSON.stringify(controllerFile)};
        export { inspectInstance, updateComponentProps } from ${JSON.stringify(runtime)};
        registerComponentDefinitions(${JSON.stringify([definition])});
        window.stopComponents = observeDocument(document, { onConnect(element) {
          setControllerModule(element, Promise.resolve(controller));
          return controller.default(getComponentHost(element));
        } });
        export const ready = Promise.resolve();`,
    };
    for (const [delivery, contents] of Object.entries(entries)) {
      const bundled = await build({ stdin: { contents, resolveDir: directory }, write: false,
        bundle: true, format: 'iife', globalName: 'Continuation', platform: 'browser', target: ['es2022'],
        treeShaking: true, minify: true, metafile: true });
      const inputs = Object.keys(bundled.metafile.inputs);
      assert.equal(inputs.some(path => /(?:jsdom|parse5|server-worker|node-loader)/.test(path)), false);
      if (delivery === 'static') {
        assert.equal(inputs.some(path => /(?:browser-source|\/parser\.ts)/.test(path)), false, 'parsed definitions do not bundle the live parser');
        staticBundle = bundled.outputFiles[0]!.text;
      } else if (delivery === 'live') liveBundle = bundled.outputFiles[0]!.text;
      else baselineBundle = bundled.outputFiles[0]!.text;
    }
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  for (const [engine, browserType] of [['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]] as const) {
    it(`${engine} renders the identical baseline in Node and resumes reads on browser connection`, async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(`${origin}/fresh`);
        await page.addScriptTag({ content: baselineBundle });
        const output = await page.evaluate(() => {
          const context = window as unknown as { Continuation: { serializeRenderedForm(element: Element): string } };
          return context.Continuation.serializeRenderedForm(document.querySelector('main')!);
        });
        assert.equal(output, rendered, 'Node and browser render and serialize the same initial component');
        await page.evaluate(() => {
          const context = window as unknown as { Continuation: { lowerDocument(): number } };
          context.Continuation.lowerDocument();
        });
        await page.waitForFunction(() => document.querySelector('#subject div')?.textContent === 'Result 1', undefined, { timeout: 2000 });
      } finally { await browser.close(); }
    });
    for (const delivery of ['live', 'static'] as const) {
      it(`${engine} adopts Node output and continues through ${delivery === 'live' ? 'the runtime loader' : 'a tree-shaken browser bundle'}`, async () => {
        const browser = await browserType.launch({ headless: true });
        try {
          const hydrated = await browser.newPage();
          const fresh = await browser.newPage();
          const errors: string[] = [];
          for (const page of [hydrated, fresh]) page.on('pageerror', error => errors.push(error.message));
          await hydrated.goto(`${origin}/hydrated`);
          await fresh.goto(`${origin}/fresh`);
          assert.equal(await hydrated.locator('output').textContent(), '3');
          assert.equal(await hydrated.locator('p').textContent(), 'Loading');
          await hydrated.evaluate(() => {
            const root = document.querySelector('#subject')!;
            const input = root.querySelector('input')!;
            Object.assign(window, { originalRoot: root, originalNodes: [...root.querySelectorAll('button, output, b, input, strong')], originalInput: input });
            input.value = 'edited before hydration';
            input.focus();
            input.setSelectionRange(2, 6);
          });
          for (const page of [hydrated, fresh]) {
            await page.addScriptTag({ content: delivery === 'live' ? liveBundle : staticBundle });
            await page.waitForFunction(() => document.querySelector('#subject div')?.textContent === 'Result 1');
          }
          const before = await inspect(hydrated);
          const freshBefore = await inspect(fresh);
          assert.deepEqual(before.instance, freshBefore.instance);
          assert.equal(before.html, freshBefore.html);
          assert.equal(before.connections, '1');
          assert.equal(before.input, 'edited before hydration');
          assert.equal(await hydrated.evaluate(() => {
            const context = window as unknown as { originalRoot: Element; originalNodes: Element[]; originalInput: HTMLInputElement };
            const root = document.querySelector('#subject')!;
            return root === context.originalRoot && context.originalNodes.every(node => root.contains(node)) &&
              document.activeElement === context.originalInput && context.originalInput.selectionStart === 2 &&
              context.originalInput.selectionEnd === 6 && root.querySelector('[data-html-next-instance]') === null;
          }), true);

          for (const page of [hydrated, fresh]) {
            await page.locator('button').click();
            await page.waitForFunction(() => document.querySelector('#subject div')?.textContent === 'Result 2');
            await page.locator('input').fill('next');
          }
          assert.deepEqual(await inspect(hydrated), await inspect(fresh));
          assert.equal(await hydrated.locator('output').textContent(), '5');
          assert.equal(await hydrated.locator('b').textContent(), '10');
          for (const page of [hydrated, fresh]) {
            await page.evaluate(async () => {
              const root = document.querySelector('#subject') as Element & { advance(): Promise<void> };
              await root.advance();
            });
            await page.waitForFunction(() => document.querySelector('#subject div')?.textContent === 'Result 3');
            await page.evaluate(async () => {
              const root = document.querySelector('#subject')!;
              root.remove();
              await new Promise(resolve => setTimeout(resolve, 0));
              root.querySelector<HTMLButtonElement>('button')!.click(); // disposed listener must not write
              document.querySelector('main')!.append(root);
            });
            await page.waitForFunction(() => document.querySelector('#subject')?.getAttribute('data-connections') === '2');
            await page.locator('button').click();
            await page.waitForFunction(() => document.querySelector('#subject div')?.textContent === 'Result 4');
          }
          assert.deepEqual(await inspect(hydrated), await inspect(fresh));
          assert.equal(await hydrated.locator('output').textContent(), '9', 'one listener after reconnection');
          assert.equal(await hydrated.locator('b').textContent(), '18');
          for (const page of [hydrated, fresh]) {
            await page.evaluate(() => {
              const context = window as unknown as { Continuation: { updateComponentProps(element: Element, props: Record<string, unknown>): void } };
              context.Continuation.updateComponentProps(document.querySelector('#subject')!, { step: 3 });
            });
            await page.waitForFunction(() => document.querySelector('#subject b')?.textContent === '27');
            await page.locator('button').click();
            await page.waitForFunction(() => document.querySelector('#subject div')?.textContent === 'Result 5');
          }
          assert.deepEqual(await inspect(hydrated), await inspect(fresh));
          assert.equal(await hydrated.locator('output').textContent(), '12');
          assert.equal(await hydrated.locator('b').textContent(), '36');
          assert.deepEqual(errors, []);
        } finally { await browser.close(); }
      });
    }
  }
});
