// A proof-of-concept HTML Next runtime. Minimal, unbundled, native ES modules.
//
// It demonstrates the REGISTRATION + LOADING + WIRING model, not the full spec:
//  - components register by tag in a customElements-shaped registry;
//  - definitions are inert .html data; a definition may name the controller it requests,
//    but importing the definition cannot execute it;
//  - the application authorizes controller URLs through conventional names in its import map;
//    approved controllers
//    load lazily via import() on first connect and self-register with defineController(tag, fn);
//  - a tiny reactive state lets a controller drive the DOM (drive state, not the DOM);
//  - lowered roots are torn down (effects + disconnect) when removed from the DOM;
//  - author markup is sanitized on lowering (script / on* / javascript: / srcdoc dropped;
//    this is a demo stand-in, NOT a security boundary — see the sanitize() note).
//
// ponytail: still POC-simplified — dotted-path expressions only (no operators, no $if/$each),
// EAGER-transitive definition loading (the spec's model is demand-driven), coarse reactivity,
// no SSR/hydration. See README for the full list. The production runtime (src/runtime.ts) has
// the real expression engine and control flow; this file proves the composition/loading shape.

const registry = new Map(); // tag -> { template }
const controllers = new Map(); // tag -> fn
const controllerRequests = new Map(); // tag -> resolved URL requested by <link rel="controller">
const importing = new Set(); // canonical controller specifiers whose import() is in flight
const loaded = new Set(); // definition URLs already fetched
const whenDefinedResolvers = new Map();

// ---------------------------------------------------------------------------
// Registry — shaped like customElements
// ---------------------------------------------------------------------------

export function defineController(tag, fn) {
  controllers.set(tag, fn);
  // Upgrade: run the controller on already-lowered, not-yet-controlled instances,
  // exactly like a late customElements.define upgrades existing elements.
  document.querySelectorAll(`[data-component]`).forEach((root) => {
    if (root.__tag === tag && !root.__controlled) connect(root);
  });
}

export const components = {
  define(tag, template) {
    if (registry.has(tag)) {
      // Like customElements.define, a tag may be defined once (security.vue: no silent winner).
      console.error(`[html-next] <${tag}> is already defined; ignoring the duplicate definition.`);
      return;
    }
    registry.set(tag, { template });
    (whenDefinedResolvers.get(tag) || []).forEach((r) => r());
    whenDefinedResolvers.delete(tag);
  },
  defineController,
  get: (tag) => registry.get(tag),
  whenDefined: (tag) =>
    registry.has(tag)
      ? Promise.resolve()
      : new Promise((resolve) => {
          const list = whenDefinedResolvers.get(tag) || [];
          list.push(resolve);
          whenDefinedResolvers.set(tag, list);
        }),
};

// ---------------------------------------------------------------------------
// Reactivity — a tiny signal system with proper per-effect cleanup
// ---------------------------------------------------------------------------

let currentEffect = null;
const pending = new Set();
let scheduled = false;

function flush() {
  scheduled = false;
  const fns = [...pending];
  pending.clear();
  fns.forEach((e) => !e.disposed && e.execute());
}
function schedule(effect) {
  pending.add(effect);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(flush);
  }
}
function unsubscribe(effect) {
  effect.deps.forEach((set) => set.delete(effect));
  effect.deps.clear();
}
// Create an effect that re-runs when a reactive key it read changes. Returns the effect
// so its owner can dispose it (unsubscribe) on disconnect.
function createEffect(run) {
  const effect = { run, deps: new Set(), disposed: false };
  effect.execute = () => {
    if (effect.disposed) return;
    unsubscribe(effect); // clear stale subscriptions before re-tracking (no over-firing/leaks)
    const prev = currentEffect;
    currentEffect = effect;
    try {
      run();
    } finally {
      currentEffect = prev;
    }
  };
  effect.execute();
  return effect;
}

function reactive(obj) {
  const subs = new Map(); // key -> Set(effect)
  return new Proxy(obj, {
    get(target, key) {
      if (currentEffect) {
        let set = subs.get(key);
        if (!set) subs.set(key, (set = new Set()));
        set.add(currentEffect);
        currentEffect.deps.add(set);
      }
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      const set = subs.get(key);
      if (set) [...set].forEach(schedule);
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// Expression evaluation (POC: a JSON literal, or a dotted path into scope)
// ---------------------------------------------------------------------------

function evalExpr(expr, scope) {
  const text = expr.trim();
  try {
    return JSON.parse(text); // numbers, "strings", [arrays], true/false/null
  } catch {
    /* not a literal — treat as a path */
  }
  const value = text.split(".").reduce((v, k) => (v == null ? undefined : v[k]), scope);
  if (value === undefined) console.warn(`[html-next] expression "${expr}" resolved to nothing.`);
  return value;
}

// ---------------------------------------------------------------------------
// Sanitizing author markup on lowering. Definitions are inert, but their markup must
// still be safe to render, so this drops the common script vectors: <script>, on*
// handlers, javascript: URLs, and iframe srcdoc.
// ponytail: this is NOT a security boundary — it covers the obvious vectors so the demo
// is safe, but the real runtime uses the HTML Sanitizer API (Element.setHTML). Do not
// rely on this function's completeness.
// ---------------------------------------------------------------------------

const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "xlink:href"]);
const DROP_ATTRS = new Set(["srcdoc"]); // an iframe srcdoc can carry a whole executable document

// Browsers strip C0 controls and whitespace from a URL before resolving its scheme, so a
// `java\tscript:` or a leading-control-char URL still runs. Normalize before testing.
function dangerousUrl(value) {
  return /^javascript:/i.test(String(value).replace(/[\u0000-\u0020]+/g, ""));
}

function sanitize(root) {
  const walk = (el) => {
    if (el.localName === "script") {
      el.remove();
      return;
    }
    [...el.attributes].forEach((a) => {
      const name = a.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(a.name);
      else if (DROP_ATTRS.has(name)) el.removeAttribute(a.name);
      else if (URL_ATTRS.has(name) && dangerousUrl(a.value)) el.removeAttribute(a.name);
    });
    [...el.children].forEach(walk);
  };
  walk(root);
}

// ---------------------------------------------------------------------------
// Loading definitions (transitive, like an ES-module graph)
// ---------------------------------------------------------------------------

async function loadDefinition(url) {
  if (loaded.has(url)) return; // dedup by URL: safe for diamonds (B,C -> D) and cycles (A <-> B)
  loaded.add(url);
  const res = await fetch(url);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");

  const template = doc.querySelector("template[component]");
  if (!template) return;
  const tag = template.getAttribute("component");

  const controllerLink = doc.querySelector('link[rel="controller"][href]');
  if (controllerLink) {
    controllerRequests.set(tag, new URL(controllerLink.getAttribute("href"), url).href);
  }
  components.define(tag, template);

  const deps = [...doc.querySelectorAll('link[rel="component"]')].map(
    (l) => new URL(l.getAttribute("href"), url).href,
  );
  await Promise.all(deps.map(loadDefinition));
}

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

function markupRoot(template) {
  // ponytail: takes the first non-defs/non-style child; a definition has exactly one root, so
  // trailing siblings (a malformed multi-root definition) are silently ignored here.
  return [...template.content.children].find(
    (c) => c.localName !== "defs" && c.localName !== "style",
  );
}

function buildScope(template, el) {
  const scope = {};
  const defs = template.content.querySelector("defs");
  defs?.querySelectorAll("prop").forEach((p) => {
    const name = p.getAttribute("name");
    const type = p.getAttribute("type");
    let val = el.getAttribute(name) ?? p.getAttribute("default") ?? null;
    if (type === "number" && val != null) val = Number(val);
    if (type === "boolean") val = el.hasAttribute(name);
    scope[name] = val;
  });
  const state = reactive(scope);
  defs?.querySelectorAll("state").forEach((s) => {
    const name = s.getAttribute("name");
    const v = s.getAttribute(":value");
    state[name] = v == null ? null : evalExpr(v, state);
  });
  return state;
}

function bindTree(node, scope, refs, slotChildren, effects) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  if (node.localName === "slot") {
    node.replaceWith(...slotChildren.map((n) => n.cloneNode(true)));
    return;
  }
  if (node.hasAttribute("$ref")) {
    refs[node.getAttribute("$ref")] = node;
    node.removeAttribute("$ref");
  }
  if (node.hasAttribute("$value")) {
    const expr = node.getAttribute("$value");
    node.removeAttribute("$value");
    effects.push(createEffect(() => {
      node.textContent = String(evalExpr(expr, scope) ?? "");
    }));
  }
  [...node.attributes].forEach((a) => {
    if (!a.name.startsWith(":")) return;
    const name = a.name.slice(1);
    const expr = a.value;
    node.removeAttribute(a.name);
    effects.push(createEffect(() => {
      let v = evalExpr(expr, scope);
      const lower = name.toLowerCase();
      if (DROP_ATTRS.has(lower)) v = null; // no bound srcdoc
      if (URL_ATTRS.has(lower) && dangerousUrl(v)) v = null; // no bound javascript: sink
      if (v == null || v === false) node.removeAttribute(name);
      else node.setAttribute(name, v === true ? "" : String(v));
    }));
  });
  [...node.childNodes].forEach((c) => bindTree(c, scope, refs, slotChildren, effects));
}

function lowerElement(el) {
  const tag = el.localName;
  const def = registry.get(tag);
  if (!def) return;
  if (customElements.get(tag)) {
    // The tag is a registered custom element; the browser owns it. Do not fight it.
    console.warn(`[html-next] <${tag}> is a defined custom element; skipping HTML Next lowering.`);
    return;
  }

  const scope = buildScope(def.template, el);
  const refs = {};
  const effects = [];
  const slotChildren = [...el.childNodes];
  const root = markupRoot(def.template).cloneNode(true);
  sanitize(root); // author markup made safe before it becomes live
  bindTree(root, scope, refs, slotChildren, effects);

  const prior = el.getAttribute("data-component");
  root.setAttribute("data-component", prior ? `${tag} ${prior}` : tag);
  root.__tag = tag;
  root.__scope = scope;
  root.__refs = refs;
  root.__effects = effects;
  el.replaceWith(root);

  lowerAll(root); // nested components
  connectOrLoad(root); // controller (lazy)
}

function lowerAll(container) {
  // ponytail: O(tags × instances) rescan-from-scratch after each lowering; fine at POC scale.
  // A self-referential component (its markup root is its own tag) is not handled — that needs
  // $if/$each to terminate, which this POC does not implement.
  let changed = true;
  while (changed) {
    changed = false;
    for (const tag of registry.keys()) {
      const el = container.querySelector(`${tag}:not([data-component])`);
      if (el) {
        lowerElement(el);
        changed = true;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Controllers — the host, lazy connect, and teardown
// ---------------------------------------------------------------------------

function makeHost(root) {
  const onDisconnect = [];
  root.__onDisconnect = onDisconnect;
  return {
    state: root.__scope,
    refs: root.__refs,
    elements: {}, // (POC omits form named-access)
    effect: (fn) => {
      const e = createEffect(fn);
      root.__effects.push(e);
      return e;
    },
    on(event, fn) {
      if (event === "connect") fn();
      else if (event === "disconnect") onDisconnect.push(fn);
      else root.addEventListener(event, fn);
    },
    dispatch: (event, detail) =>
      root.dispatchEvent(new CustomEvent(event, { detail, bubbles: true })),
  };
}

function connect(root) {
  if (root.__controlled) return;
  root.__controlled = true;
  const host = makeHost(root);
  const dispose = controllers.get(root.__tag)(host);
  if (typeof dispose === "function") root.__onDisconnect.push(dispose);
}

function connectOrLoad(root) {
  const tag = root.__tag;
  if (controllers.has(tag)) {
    connect(root);
    return;
  }
  const requested = controllerRequests.get(tag);
  if (!requested) return;
  const specifier = `html-next-controller/${tag}`;
  if (importing.has(specifier)) return;
  let approved;
  try {
    // Resolution consults the application's import map but fetches and executes nothing.
    approved = import.meta.resolve(specifier);
  } catch {
    console.error(
      `[html-next] <${tag}> requested ${requested}, but the application did not approve ${specifier}.`,
    );
    return;
  }
  if (requested !== approved) {
    console.error(
      `[html-next] <${tag}> requested ${requested}, but the application approved ${approved}; refusing to execute either.`,
    );
    return;
  }
  importing.add(specifier);
  // The module's own defineController() call registers + upgrades this instance (and siblings).
  // Import the approved name, never the component-provided string.
  import(specifier).catch((err) =>
    console.error(`[html-next] approved controller ${specifier} failed to load:`, err),
  );
}

function disposeRoot(root) {
  if (root.__disposed) return;
  root.__disposed = true;
  (root.__effects || []).forEach((e) => {
    e.disposed = true;
    unsubscribe(e);
  });
  (root.__onDisconnect || []).forEach((f) => f());
}

// Observe removals so teardown (effect disposal + on:disconnect) actually runs.
new MutationObserver((records) => {
  for (const record of records) {
    record.removedNodes.forEach((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.hasAttribute("data-component")) disposeRoot(node);
      node.querySelectorAll?.("[data-component]").forEach(disposeRoot);
    });
  }
}).observe(document.documentElement, { childList: true, subtree: true });

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function boot() {
  document.querySelectorAll("template[component]").forEach((tpl) => {
    components.define(tpl.getAttribute("component"), tpl);
  });
  const links = [...document.querySelectorAll('link[rel="component"]')];
  await Promise.all(
    links.map((l) => loadDefinition(new URL(l.getAttribute("href"), location.href).href)),
  );
  lowerAll(document.body);
}

boot();
