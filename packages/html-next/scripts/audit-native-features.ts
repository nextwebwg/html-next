import { chromium, firefox, webkit, type BrowserType } from "playwright";

interface BrowserSurfaceAudit {
  readonly abortSignalAny: boolean;
  readonly abortSignalTimeout: boolean;
  readonly cssScope: boolean;
  readonly customStates: boolean;
  readonly importMaps: boolean;
  readonly moveBefore: boolean;
  readonly parseHTML: boolean;
  readonly sanitizer: boolean;
  readonly schedulerPostTask: boolean;
  readonly setHTML: boolean;
  readonly setHTMLResult: string | null;
}

const sanitizerFixture =
  `<b>ok</b><script>x</script><img src="x" onerror="x">` +
  `<a href="javascript:x">bad</a><iframe srcdoc="x"></iframe>` +
  `<form><input name="x"></form>`;

const engines: ReadonlyArray<readonly [string, BrowserType]> = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
];

const results: Record<string, BrowserSurfaceAudit> = {};
for (const [name, engine] of engines) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    results[name] = await page.evaluate((sample) => {
      const element = document.createElement("div") as HTMLDivElement & {
        setHTML?: (source: string) => void;
      };
      let setHTMLResult: string | null = null;
      if (typeof element.setHTML === "function") {
        element.setHTML(sample);
        setHTMLResult = element.innerHTML;
      }

      const style = document.createElement("style");
      document.head.append(style);
      let cssScope = false;
      try {
        style.sheet?.insertRule("@scope (.audit) { :scope { color: red; } }");
        cssScope = style.sheet?.cssRules.length === 1;
      } catch {
        cssScope = false;
      } finally {
        style.remove();
      }

      const parentNode = Element.prototype as Element & { moveBefore?: unknown };
      const documentConstructor = Document as typeof Document & { parseHTML?: unknown };
      const elementInternals = globalThis.ElementInternals?.prototype as
        | (ElementInternals & { states?: unknown })
        | undefined;
      const scheduler = (globalThis as typeof globalThis & {
        scheduler?: { postTask?: unknown };
      }).scheduler;
      return {
        abortSignalAny: typeof AbortSignal.any === "function",
        abortSignalTimeout: typeof AbortSignal.timeout === "function",
        cssScope,
        customStates: elementInternals !== undefined && "states" in elementInternals,
        importMaps: HTMLScriptElement.supports?.("importmap") === true,
        moveBefore: typeof parentNode.moveBefore === "function",
        parseHTML: typeof documentConstructor.parseHTML === "function",
        sanitizer: typeof globalThis.Sanitizer === "function",
        schedulerPostTask: typeof scheduler?.postTask === "function",
        setHTML: typeof element.setHTML === "function",
        setHTMLResult,
      };
    }, sanitizerFixture);
  } finally {
    await browser.close();
  }
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
