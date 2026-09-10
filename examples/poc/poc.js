// A proof-of-concept HTML Next runtime. Minimal, unbundled, native ES modules.
//
// It demonstrates the REGISTRATION + LOADING + WIRING model, not the full spec:
//  - components register by tag in a customElements-shaped registry;
//  - definitions are inert .html data; controllers are .js modules that self-register
//    with an explicit defineController(tag, fn) call;
//  - controllers load lazily via import() on first connect;
//  - a tiny reactive state lets a controller drive the DOM (drive state, not the DOM).
//
// ponytail: lowering is deliberately coarse — dotted-path expressions only (no operators,
// no $if/$each), coarse per-binding effects. The production runtime (src/runtime.ts) has the
// real expression engine and control flow; this file exists to prove the composition/loading
// shape end to end, runnable by opening index.html through any static server.

const registry = new Map(); // tag -> { template }
const controllers = new Map(); // tag -> fn
const controllerHints = new Map(); // tag -> module URL (from <link rel="controller">)
const loaded = new Set(); // definition URLs already fetched
const whenDefinedResolvers = new Map();

// ---------------------------------------------------------------------------
// Registry — shaped like customElements
// ---------------------------------------------------------------------------

export function defineController(tag, fn) {
  controllers.set(tag, fn);
  // Upgrade: run the controller on any already-lowered, not-yet-controlled instances,
  // exactly like a late customElements.define upgrades existing elements.
  document.querySelectorAll(`[data-component~="${tag}"]`).forEach((root) => {
    if (root.__tag === tag && !root.__controlled) connect(root);
  });
}

export const components = {
  define(tag, template) {
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
// Reactivity — a tiny signal system (read-tracking + microtask-batched effects)
// ---------------------------------------------------------------------------

let currentEffect = null;
const pending = new Set();
let scheduled = false;

function flush() {
  scheduled = false;
  const fns = [...pending];
  pending.clear();
  fns.forEach(runEffect);
}
function schedule(fn) {
  pending.add(fn);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(flush);
  }
}
function runEffect(fn) {
  const prev = currentEffect;
  currentEffect = fn;
  try {
    fn();
  } finally {
    currentEffect = prev;
  }
}

function reactive(obj) {
  const subs = new Map(); // key -> Set(effect)
  return new Proxy(obj, {
    get(target, key) {
      if (currentEffect) {
        let set = subs.get(key);
        if (!set) subs.set(key, (set = new Set()));
        set.add(currentEffect);
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
  return text.split(".").reduce((v, k) => (v == null ? undefined : v[k]), scope);
}

// ---------------------------------------------------------------------------
// Loading definitions (transitive, like an ES-module graph)
// ---------------------------------------------------------------------------

async function loadDefinition(url) {
  if (loaded.has(url)) return;
  loaded.add(url);
  const res = await fetch(url);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");

  const template = doc.querySelector("template[component]");
  if (!template) return;
  const tag = template.getAttribute("component");

  const controllerLink = doc.querySelector('link[rel="controller"]');
  if (controllerLink) {
    controllerHints.set(tag, new URL(controllerLink.getAttribute("href"), url).href);
  }
  components.define(tag, template);

  // Each definition declares its OWN component dependencies; walk them transitively.
  const deps = [...doc.querySelectorAll('link[rel="component"]')].map(
    (l) => new URL(l.getAttribute("href"), url).href,
  );
  await Promise.all(deps.map(loadDefinition));
}

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

function markupRoot(template) {
  return [...template.content.children].find(
    (c) => c.localName !== "defs" && c.localName !== "style",
  );
}

function buildScope(template, el) {
  const scope = {};
  const defs = template.content.querySelector("defs");
  // props from invocation attributes (typed coercion for number/boolean)
  defs?.querySelectorAll("prop").forEach((p) => {
    const name = p.getAttribute("name");
    const type = p.getAttribute("type");
    let val = el.getAttribute(name) ?? p.getAttribute("default") ?? null;
    if (type === "number" && val != null) val = Number(val);
    if (type === "boolean") val = el.hasAttribute(name);
    scope[name] = val;
  });
  const state = reactive(scope);
  // state decls may read props declared above them
  defs?.querySelectorAll("state").forEach((s) => {
    const name = s.getAttribute("name");
    const v = s.getAttribute(":value");
    state[name] = v == null ? null : evalExpr(v, state);
  });
  return state;
}

function bindTree(node, scope, refs, slotChildren) {
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
    runEffect(() => {
      node.textContent = String(evalExpr(expr, scope) ?? "");
    });
  }
  [...node.attributes].forEach((a) => {
    if (!a.name.startsWith(":")) return;
    const name = a.name.slice(1);
    const expr = a.value;
    node.removeAttribute(a.name);
    runEffect(() => {
      const v = evalExpr(expr, scope);
      if (v == null || v === false) node.removeAttribute(name);
      else node.setAttribute(name, v === true ? "" : String(v));
    });
  });
  [...node.childNodes].forEach((c) => bindTree(c, scope, refs, slotChildren));
}

function lowerElement(el) {
  const tag = el.localName;
  const def = registry.get(tag);
  if (!def) return;

  const scope = buildScope(def.template, el);
  const refs = {};
  const slotChildren = [...el.childNodes];
  const root = markupRoot(def.template).cloneNode(true);
  bindTree(root, scope, refs, slotChildren);

  const prior = el.getAttribute("data-component");
  root.setAttribute("data-component", prior ? `${tag} ${prior}` : tag);
  root.__tag = tag;
  root.__scope = scope;
  root.__refs = refs;
  el.replaceWith(root);

  lowerAll(root); // nested components
  connectOrLoad(root); // controller (lazy)
}

function lowerAll(container) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const tag of registry.keys()) {
      const el = container.querySelector(tag);
      if (el) {
        lowerElement(el);
        changed = true;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Controllers — the host, and lazy connect
// ---------------------------------------------------------------------------

function makeHost(root) {
  const onDisconnect = [];
  return {
    state: root.__scope,
    refs: root.__refs,
    elements: {}, // (POC omits form named-access)
    effect: (fn) => runEffect(fn),
    on(event, fn) {
      if (event === "connect") fn();
      else if (event === "disconnect") onDisconnect.push(fn);
      else root.addEventListener(event, fn);
    },
    dispatch: (event, detail) =>
      root.dispatchEvent(new CustomEvent(event, { detail, bubbles: true })),
    __disconnect: () => onDisconnect.forEach((f) => f()),
  };
}

function connect(root) {
  if (root.__controlled) return;
  root.__controlled = true;
  const fn = controllers.get(root.__tag);
  const host = makeHost(root);
  const dispose = fn(host);
  root.__dispose = typeof dispose === "function" ? dispose : host.__disconnect;
}

function connectOrLoad(root) {
  const tag = root.__tag;
  if (controllers.has(tag)) {
    connect(root);
    return;
  }
  const url = controllerHints.get(tag);
  if (url) import(url); // the module's own defineController() call registers + upgrades this instance
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function boot() {
  // inline <template component> definitions
  document.querySelectorAll("template[component]").forEach((tpl) => {
    components.define(tpl.getAttribute("component"), tpl);
  });
  // linked definitions, walked transitively
  const links = [...document.querySelectorAll('link[rel="component"]')];
  await Promise.all(
    links.map((l) => loadDefinition(new URL(l.getAttribute("href"), location.href).href)),
  );
  lowerAll(document.body);
}

boot();
