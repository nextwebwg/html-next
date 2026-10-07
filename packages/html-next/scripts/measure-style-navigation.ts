import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "playwright";

const argument = (name: string, fallback: string): string =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const fixturePath = resolve(argument("fixture", ".context/compound-engineering/ce-optimize/style-delivery/confirmation/navigation-fixture.json"));
const output = resolve(argument("out", ".context/compound-engineering/ce-optimize/style-delivery/navigation"));
const samples = Number(argument("samples", "7"));
const warmups = Number(argument("warmups", "2"));
const cssDelay = Number(argument("css-delay", "75"));
const scriptDelay = Number(argument("script-delay", "220"));
assert(Number.isInteger(samples) && samples > 0);
for (const value of [warmups, cssDelay, scriptDelay]) assert(Number.isInteger(value) && value >= 0);
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
  compiled: string[]; nativeRoots: string; backdrop: string; baseCSS: string;
};
const css = fixture.compiled.join("\n");
const modes = ["head-link", "late-inline", "late-link", "preload-late-link"] as const;
const bootstrap = `
performance.mark('navigation-start');
window.measurement = {paints: [], shifts: [], cssReady: 0, cssApplied: 0, ready: false};
new PerformanceObserver(list => window.measurement.paints.push(...list.getEntries().map(e => ({name: e.name, time: e.startTime})))).observe({type:'paint', buffered:true});
new PerformanceObserver(list => window.measurement.shifts.push(...list.getEntries().filter(e => !e.hadRecentInput).map(e => ({value:e.value,time:e.startTime})))).observe({type:'layout-shift', buffered:true});
`;
const server = createServer((request, response) => {
  const url = new URL(request.url!, "http://localhost");
  const mode = url.searchParams.get("mode");
  if (url.pathname === "/style.css") {
    setTimeout(() => { response.writeHead(200, { "Content-Type": "text/css", "Cache-Control": "max-age=600" }); response.end(css); }, cssDelay);
  } else if (url.pathname === "/app.js") {
    const apply = mode === "late-inline" ? `const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);` :
      mode === "head-link" ? "" : `await new Promise(done => {const link=document.createElement('link');link.rel='stylesheet';link.href='/style.css';link.onload=done;document.head.append(link);});`;
    const app = `(async () => {performance.mark('application-start');${apply}
      window.measurement.cssReady=performance.now();
      if(!window.measurement.cssApplied) window.measurement.cssApplied=window.measurement.cssReady;
      performance.mark('css-ready');
      await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
      performance.mark('navigation-end');window.measurement.ready=true;
    })();`;
    setTimeout(() => { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(app); }, scriptDelay);
  } else {
    const headCSS = mode === "head-link" ? '<link rel="stylesheet" href="/style.css" onload="window.measurement.cssApplied=performance.now()">' :
      mode === "preload-late-link" ? '<link rel="preload" as="style" href="/style.css">' : "";
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(`<!doctype html><html><head><script>${bootstrap}</script><style>${fixture.baseCSS}</style>${headCSS}<script defer src="/app.js?mode=${mode}"></script></head><body><main>${fixture.nativeRoots}</main><aside>${fixture.backdrop}</aside></body></html>`);
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address !== null && typeof address !== "string");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report: { metadata: Record<string, unknown>; runs: Record<string, unknown[]>; traces: Record<string, unknown> } = {
  metadata: { browser: browser.version(), fixture: fixturePath, css_delay_ms: cssDelay, script_delay_ms: scriptDelay,
    samples, warmups, timing: "Cold independent browser contexts; rotated order; actual HTTP navigation; no CPU throttle",
    caveat: "Controlled network delays demonstrate delivery semantics; these are not production network forecasts." },
  runs: Object.fromEntries(modes.map((mode) => [mode, []])), traces: {},
};
const persist = async (): Promise<void> => {
  const path = resolve(output, "results.json");
  await writeFile(path, JSON.stringify(report, null, 2));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), report);
};
try {
  for (let round = 0; round < samples + warmups + 1; round += 1) {
    const traceRound = round === samples + warmups;
    const ordering = [...modes.slice(round % modes.length), ...modes.slice(0, round % modes.length)];
    for (const mode of ordering) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
      const page = await context.newPage();
      try {
        const session = traceRound ? await context.newCDPSession(page) : undefined;
        if (session !== undefined) await session.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,disabled-by-default-devtools.screenshot", transferMode: "ReturnAsStream" });
        await page.goto(`http://127.0.0.1:${address.port}/?mode=${mode}`);
        await page.waitForFunction("window.measurement.ready === true");
        const result = await page.evaluate(`(() => {
          const m=window.measurement;
          const first=document.querySelector('main>article');
          const fcp=m.paints.find(p=>p.name==='first-contentful-paint')?.time;
          const cssResource=performance.getEntriesByType('resource').find(r=>r.name.endsWith('/style.css'));
          return {fcp_ms:fcp, application_ready_ms:m.cssReady, css_applied_ms:m.cssApplied, css_response_end_ms:cssResource?.responseEnd??null,
            cls:m.shifts.reduce((sum,s)=>sum+s.value,0), shifts:m.shifts,
            unstyled_window_ms:${mode === "head-link" ? "0" : "Math.max(0,m.cssApplied-fcp)"},
            final_color:getComputedStyle(first).backgroundColor, root_count:document.querySelectorAll('main>article').length,
            paints:m.paints};
        })()`) as { final_color: string; root_count: number };
        assert.equal(result.final_color, "rgb(200, 220, 240)");
        assert.equal(result.root_count, fixture.nativeRoots.match(/<article/g)!.length);
        if (!traceRound && round >= warmups) report.runs[mode]!.push(result);
        if (session !== undefined) {
          const complete = new Promise<{ stream?: string }>((done) => session.once("Tracing.tracingComplete", done));
          await session.send("Tracing.end");
          const { stream } = await complete;
          assert(stream !== undefined);
          let source = "";
          for (;;) {
            const chunk = await session.send("IO.read", { handle: stream });
            source += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data;
            if (chunk.eof) break;
          }
          await session.send("IO.close", { handle: stream });
          const path = resolve(output, `${mode}.trace.json`);
          await writeFile(path, source);
          const trace = JSON.parse(await readFile(path, "utf8"));
          const start = trace.traceEvents.find((event: { name: string }) => event.name === "navigation-start");
          const end = trace.traceEvents.find((event: { name: string }) => event.name === "navigation-end");
          assert(start && end);
          const events = trace.traceEvents.filter((event: { ph: string; ts: number; pid: number; tid: number }) => event.ph === "X" && event.pid === start.pid && event.tid === start.tid && event.ts >= start.ts && event.ts < end.ts);
          const rendering = Object.fromEntries(["UpdateLayoutTree", "Layout", "Paint"].map((name) => {
            const matching = events.filter((event: { name: string }) => event.name === name);
            return [name, { count: matching.length, total_ms: matching.reduce((sum: number, event: { dur?: number }) => sum + (event.dur ?? 0), 0) / 1000 }];
          }));
          report.traces[mode] = { file: path, result, rendering };
          await session.detach();
        }
        await persist();
      } finally { await context.close(); }
    }
    process.stderr.write(`navigation: ${traceRound ? "traces" : `round ${round + 1}/${samples + warmups}`}\n`);
  }
} finally {
  await browser.close();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
