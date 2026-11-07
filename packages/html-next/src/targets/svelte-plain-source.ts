import ts from "typescript-compiler";
import type { GeneratedArtifact } from "../generate.js";
import { formatSvelteScript } from "./vue-format.js";
import { NATIVE_CONNECTION_SOURCE } from "./native-connection-source.js";

/** Rune-side source lookup stays separate from the ordinary renderer bridge. */
export const SVELTE_PLAIN_SLOTS_SOURCE = String.raw`function childPlainFrame(child: ListedChild, name: string): PlainFrame {
  let frame = child.plain.get(name);
  if (frame === undefined) {
    frame = new PlainFrame(() => {
      child.list();
      const slot = child.slots[name];
      return slot === undefined || slot[4] === false ? undefined : { snippet: slot[0], args: slot[3] === true ? {} : { p: {}, s: slot[1], a: childPlace(child, name) } };
    });
    child.plain.set(name, frame);
  }
  return frame;
}
function inputSnippet(read: () => PlainInput | undefined, fallback?: Snippet): Snippet {
  return ((target: any) => { const given = read(); if (given === undefined) (fallback as any)?.(target);
    else (given.snippet as any)(target, typeof document === "undefined" ? given.args : () => read()?.args); }) as unknown as Snippet;
}
export function usePlainSlots(read: (name: string) => Snippet<[any]> | undefined, placed?: { child(): ListedChild | undefined }): (name: string, outlet: object, fallback?: Snippet) => Snippet {
  const own = new Map<string, PlainFrame>();
  const native = new WeakMap<object, { source: Snippet<[any]>; render: Snippet }>();
  const direct = (outlet: object, source: Snippet<[any]>, read: () => PlainInput | undefined, fallback?: Snippet): Snippet => {
    const known = native.get(outlet);
    if (known?.source === source) return known.render;
    const render = inputSnippet(read, fallback); native.set(outlet, { source, render }); return render;
  };
  onDestroy(() => { for (const frame of own.values()) frame.dispose(); });
  return (name, outlet, fallback) => {
    const given = read(name);
    const child = placed?.child();
    if (child !== undefined && child.slots[name] !== undefined) {
      if (child.slots[name]![2]) return childPlainFrame(child, name).outlet(outlet, fallback);
      return direct(outlet, child.slots[name]![0], () => { child.list(); const slot = child.slots[name]; return slot === undefined ? undefined
        : { snippet: slot[0], args: slot[3] === true ? {} : { p: {}, s: slot[1], a: childPlace(child, name) } }; }, fallback);
    }
    if (given !== undefined && !isPlainSnippet(given)) return direct(outlet, given, () => { const snippet = read(name); return snippet === undefined ? undefined : { snippet, args: {} }; }, fallback);
    let frame = own.get(name);
    if (frame === undefined) {
      frame = new PlainFrame(() => { const snippet = read(name); return snippet === undefined ? undefined : { snippet, args: {} }; });
      own.set(name, frame);
    }
    return frame.outlet(outlet, fallback);
  };
}
`;

const SOURCE = `import { onDestroy, onMount, untrack, type Snippet } from "svelte";
import { active_effect as nativePlainEffect, effect_root as nativePlainRoot, snippet as nativePlainSnippet, comment as nativePlainComment, first_child as nativePlainFirst, next as nativePlainNext, append as nativePlainAppend, state as nativePlainState, get as nativePlainGet, set as nativePlainSet } from "svelte/internal/client";
${NATIVE_CONNECTION_SOURCE}

interface PlainEffect {
  nodes: { start: Node | null; end: Node | null; a: null; t: PlainTransition[] | null } | null;
}
interface PlainTransition { is_global: boolean; in(): void; out(done: () => void): void; stop(): void; }
export type PlainInput = { snippet: Snippet<[any]>; args: unknown };
const plainSnippets = /* @__PURE__ */ new WeakSet<object>();
export function plainSnippet<T extends Snippet<any>>(snippet: T): T { plainSnippets.add(snippet); return snippet; }
export const isPlainSnippet = (snippet: object): boolean => plainSnippets.has(snippet);
const emptyPlainSnippet = (): void => {};
interface PlainSite { anchor?: Node; released?: boolean; fallback?: boolean; }
export class PlainFrame {
  private readonly revision = nativePlainState(0);
  private readonly sites = new Set<PlainSite>();
  private readonly outlets = new WeakMap<object, Snippet>();
  private owner: PlainSite | undefined;
  private root: PlainEffect | undefined;
  private stop: (() => void) | undefined;
  private park: DocumentFragment | undefined;
  private retired = false;
  private unobserve: (() => void) | undefined;
  constructor(readonly read: () => PlainInput | undefined) {}
  private nodes(): Node[] {
    const nodes: Node[] = [];
    for (let node = this.root?.nodes?.start; node != null; node = node.nextSibling) {
      nodes.push(node); if (node === this.root!.nodes!.end) break;
    }
    return nodes;
  }
  private choose(): void {
    if (this.retired || this.owner?.anchor?.isConnected) return;
    queueMicrotask(() => {
      if (this.retired || this.owner?.anchor?.isConnected) return;
      this.owner = [...this.sites].filter(site => !site.released && site.anchor?.isConnected)
        .sort((left, right) => left.anchor!.compareDocumentPosition(right.anchor!) & 4 ? -1 : 1)[0];
      untrack(() => { nativePlainSet(this.revision, nativePlainGet(this.revision) + 1); });
    });
  }
  private release(site: PlainSite): void {
    site.released = true;
    if (this.owner !== site) return;
    this.parkSource();
    this.owner = undefined; this.choose();
  }
  private parkSource(): void {
    const park = this.park ??= document.createDocumentFragment();
    for (const node of this.nodes()) park.appendChild(node);
  }
  dispose(): void {
    if (this.retired) return;
    this.retired = true; this.unobserve?.(); this.stop?.(); this.sites.clear();
  }
  outlet(key: object, fallback?: Snippet): Snippet {
    const known = this.outlets.get(key);
    if (known !== undefined) return known;
    const site: PlainSite = {};
    const body = (anchor: Node): void => {
      site.fallback = false;
      if (this.root === undefined) this.stop = nativePlainRoot(() => {
        // Stable native marks belong to the source effect, including when its snippet changes.
        const fragment = nativePlainComment();
        nativePlainNext();
        const target = nativePlainFirst(fragment);
        nativePlainSnippet(target, () => this.read()?.snippet ?? emptyPlainSnippet, () => this.read()?.args);
        nativePlainAppend(anchor as never, fragment as never);
        this.root = nativePlainEffect as unknown as PlainEffect;
      });
      else for (const node of this.nodes()) anchor.parentNode!.insertBefore(node, anchor);
      this.owner = site;
      site.anchor = this.root!.nodes!.end!.nextSibling ?? anchor;
      const effect = nativePlainEffect as unknown as PlainEffect;
      // The destination owns no body DOM. Its native outro runs before a removing ancestor's DOM
      // operation, so the source can park without being destroyed with the destination.
      const nodes = effect.nodes ??= { start: null, end: null, a: null, t: null };
      (nodes.t ??= []).push({ is_global: true, in: () => { site.released = false; this.choose(); },
        out: done => {
          // Native snippet reconciliation creates the fallback before pausing the old body.
          // An empty source parks its body while its destination keeps its place in ownership.
          if (site.fallback) { if (this.owner === site) this.parkSource(); }
          else this.release(site);
          done();
        }, stop() {} });
    };
    const other = (anchor: Node): void => {
      site.fallback = true;
      site.released = false;
      (fallback as unknown as ((anchor: Node) => void) | undefined)?.(anchor);
      site.anchor = (nativePlainEffect as unknown as PlainEffect).nodes?.end?.nextSibling ?? anchor;
    };
    const render = ((anchor: Node & { push(value: string): void }) => {
      site.released = false;
      this.sites.add(site);
      onDestroy(() => { this.sites.delete(site); if (typeof document !== "undefined") this.release(site); });
      if (typeof document === "undefined") {
        if (this.owner === undefined) this.owner = site;
        const given = this.read();
        if (this.owner === site && given !== undefined) {
          anchor.push("<!---->"); (given.snippet as any)(anchor, given.args); anchor.push("<!---->");
        } else (fallback as any)?.(anchor);
        return;
      }
      nativePlainSnippet(anchor as never, () => {
        void nativePlainGet(this.revision);
        if (this.owner === undefined && !site.released) this.owner = site;
        return this.owner === site && this.read() !== undefined ? body : other;
      });
      onMount(() => {
        const parent = site.anchor?.parentElement;
        if (this.unobserve === undefined && parent != null) this.unobserve = observeConnection(parent, () => this.choose());
      });
    }) as unknown as Snippet;
    this.outlets.set(key, render);
    return render;
  }
}
`;

export function sveltePlainArtifacts(version: string): readonly GeneratedArtifact[] {
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true };
  const javascript = ts.transpileModule(SOURCE, { compilerOptions: options, fileName: "plain.ts" }).outputText;
  const declarations = ts.transpileDeclaration(SOURCE, { compilerOptions: options, fileName: "plain.ts", reportDiagnostics: true });
  if (declarations.diagnostics?.length) throw new Error(ts.formatDiagnostics(declarations.diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => "", getNewLine: () => "\n",
  }));
  const header = `// Generated by HTML Next ${version}. Do not edit.\n`;
  return Object.freeze([
    Object.freeze({ path: "svelte/plain.js", content: formatSvelteScript(header + javascript, "plain.js") }),
    Object.freeze({ path: "svelte/plain.d.ts", content: formatSvelteScript(header + declarations.outputText, "plain.d.ts") }),
  ]);
}
