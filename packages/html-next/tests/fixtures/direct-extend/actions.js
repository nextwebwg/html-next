// Action scripts shared by the general-runtime and direct-extend bundles. `create` is the factory.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const main = () => document.querySelector("main");
const capture = () => {
  const warnings = [];
  const errors = [];
  console.warn = (message) => warnings.push(String(message).replace(/^.*?: HR007/, "HR007"));
  console.error = (message) => errors.push(String(message));
  addEventListener("error", (event) => { event.preventDefault(); errors.push(String(event.error?.message ?? event.message)); });
  return { warnings, errors };
};

// x-parity: list transitions, §13 semantics, the controller contract and reconnect.
window.runParity = async () => {
  const log = window.directExtendLog = { hosts: [], events: [] };
  const { warnings, errors } = capture();
  const element = create();
  const snapshots = [];
  const identities = [];
  const contract = [];
  const quiet = [];
  let previous = new Map();
  const record = () => {
    snapshots.push(element.outerHTML.replaceAll(/<!--html-next:item-(?:start|end)-->/g, ""));
    const rows = new Map(Array.from(element.querySelectorAll("li"), (row) => [row.getAttribute("data-id"), row]));
    identities.push([...rows].map(([id, row]) => id + ":" + (previous.get(id) === row ? "same" : "new")).join(","));
    previous = rows;
  };
  main().append(element);
  await flush();
  record();
  const host = log.hosts[0];
  const rowsOf = (...ids) => ids.map((id) => ({ id, label: "r" + id, tags: [] }));
  // A write that must fail before the list touches its DOM (HR004, HB001).
  const unchanged = (write) => async () => {
    const records = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(element.querySelector("ul"), { subtree: true, childList: true, attributes: true, characterData: true });
    write();
    await flush();
    records.push(...observer.takeRecords());
    observer.disconnect();
    quiet.push(records.length);
  };
  const steps = [
    () => { host.state.rows = rowsOf(1, 2, 3, 4, 5); },
    () => { host.state.selected = 2; },
    () => { const rows = host.state.rows; const second = rows[1]; rows[1] = rows[3]; rows[3] = second; },
    () => { host.state.rows[0].label = ""; host.state.rows[2].label += "!"; },
    () => { host.state.rows[0].tags.push("a", "b"); },
    () => { host.state.rows = host.state.rows.filter((row) => row.id !== 3); },
    () => { host.state.rows = host.state.rows.concat([{ id: 9, label: "n", tags: ["t"] }]); },
    () => { host.state.rows[1].id = 20; },
    () => { host.state.rows = host.state.rows.toReversed(); },
    () => { host.state.rows = [...host.state.rows.slice(2), ...host.state.rows.slice(0, 2)]; },
    () => { host.state.rows.splice(1, 1, ...rowsOf(30)); },
    () => { host.state.rows.sort((left, right) => left.id - right.id); },
    () => { host.state.rows = host.state.rows.slice(); },
    () => { host.state.rows.unshift(...rowsOf(31)); host.state.rows.push(...rowsOf(32)); },
    () => { element.querySelector("li b").append(document.createElement("u")); host.state.rows[0].label = "foreign"; },
    () => { host.state.rows[0].label = ""; },
    () => { host.state.rows[0].label = "back"; host.state.rows[0].label = "back"; },
    unchanged(() => { host.state.rows = rowsOf(1, 2, 1); }),
    () => { host.state.rows = rowsOf(1, 2); },
    unchanged(() => { host.state.rows = [undefined]; }),
    unchanged(() => { const sparse = rowsOf(0, 3); delete sparse[0]; host.state.rows = sparse; }),
    unchanged(() => { host.state.rows.length = 4; }),
    () => { host.state.rows = rowsOf(4); },
    () => { host.state.rows[0].id = "bad"; host.state.selected = "bad"; host.state.title = 3; host.state.nope = 1; },
    () => { delete host.state.title; delete host.state.rows[0].label; host.state.rows[0].extra = 1; },
    () => { try { Object.defineProperty(host.state, "title", { value: "x" }); } catch (error) { contract.push(error.name); } },
    () => { host.data.x = 1; delete host.data.y; },
    () => { host.state.title = ""; host.state.selected = null; },
    () => { host.state.rows = rowsOf(1, 2, 3); host.state.rows.length = 1; },
    () => { host.state.rows.length = 0; },
    () => { host.state.ready = false; },
    () => { host.state.rows = rowsOf(5, 6); host.state.ready = true; },
    () => { element.querySelector("li b").click(); },
  ];
  for (const step of steps) {
    await step();
    await flush();
    record();
  }
  const rows = host.state.rows;
  const signal = host.signal(1);
  signal.set(2);
  signal.update((value) => value + 1);
  element.addEventListener("ping", (event) => contract.push([event.detail, event.bubbles, event.composed, event.cancelable].join()));
  contract.push(
    host.root === element, host.element === element, Object.isFrozen(host), rows === host.state.rows,
    rows[0] === host.state.rows[0], rows[0] === rows.at(0), Array.isArray(rows), rows.length, JSON.stringify(host.state.rows),
    Object.keys(rows[0]).join(), "rows" in host.state, "nope" in host.state, String(host.state.nope),
    Object.keys(host.props).length, String(host.data.x), "x" in host.data, String(host.refs.x), "x" in host.refs,
    Array.isArray(host.slots.default), host.slots.default.length, signal.get(), host.dispatch("ping", 5),
  );
  element.remove();
  await flush();
  host.state.rows = [{ id: 7, label: "back", tags: [] }];
  await flush();
  record();
  main().append(element);
  await flush();
  record();
  element.remove();
  await flush();
  return { snapshots, identities, warnings, errors, quiet, contract, events: log.events };
};

// x-parity: the lifecycle coordinator's light-DOM scope, batch order and controller cleanup.
window.runLifecycle = async () => {
  const log = window.directExtendLog = { hosts: [], events: [] };
  const { warnings, errors } = capture();
  const step = async (name, action) => { log.events.push(name); action(); await flush(); };
  const [a, b, c] = [create(), create(), create()];
  await step("append three", () => main().append(a, b, c));
  await step("remove c, a in one batch", () => { c.remove(); a.remove(); });
  await step("move b, reattach a", () => { main().prepend(b); main().append(a); });
  const wrapper = document.createElement("div");
  await step("nest a and c in a wrapper", () => { wrapper.append(a, c); main().append(wrapper); });
  await step("remove the wrapper", () => wrapper.remove());
  await step("reattach the wrapper", () => main().append(wrapper));
  const shadowHost = document.createElement("div");
  const shadow = shadowHost.attachShadow({ mode: "open" });
  await step("attach a shadow host", () => main().append(shadowHost));
  const d = create();
  await step("append a root inside the shadow tree", () => shadow.append(d));
  await step("move c into the shadow tree", () => shadow.append(c));
  await step("remove the shadow host", () => shadowHost.remove());
  await step("reattach the shadow host", () => main().append(shadowHost));
  await step("move c back to light DOM", () => main().append(c));
  globalThis.directExtendLate = true;
  const late = create();
  await step("append a late controller", () => main().append(late));
  await step("remove it before its cleanup resolves", () => late.remove());
  await flush();
  delete globalThis.directExtendLate;
  await step("remove and reattach in one task", () => { b.remove(); main().append(b); });
  await step("remove everything", () => main().replaceChildren());
  return { events: log.events, connected: [a, b, c, d, late].map((root) => root.isConnected), warnings, errors };
};

// benchmark-app: the nine benchmark operations, driven through the controller's click delegation.
window.runBenchmark = async () => {
  const { warnings, errors } = capture();
  // Seeded labels, so both variants build the same rows.
  let seed = 1;
  Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const element = await window.mountBenchmark();
  const hash = (text) => {
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
    return (value >>> 0).toString(16);
  };
  const steps = [];
  let previous = new Map();
  const record = (name) => {
    const rows = Array.from(element.querySelectorAll("#tbody > tr"));
    const same = rows.filter((row) => previous.get(row.dataset.id) === row).length;
    previous = new Map(rows.map((row) => [row.dataset.id, row]));
    steps.push({
      name, rows: rows.length, same,
      html: hash(element.outerHTML.replaceAll(/<!--html-next:item-(?:start|end)-->/g, "")),
      order: hash(rows.map((row) => row.dataset.id).join()),
      first: rows[0]?.outerHTML, second: rows[1]?.outerHTML, last: rows.at(-1)?.outerHTML,
      selected: Array.from(element.querySelectorAll("tr.danger"), (row) => row.dataset.id).join(),
    });
  };
  const press = async (selector) => { element.querySelector(selector).click(); await flush(); };
  const click = async (name, selector) => { await press(selector); record(name); };
  record("connect");
  await click("create 1,000 rows", "#run");
  await click("replace 1,000 rows", "#run");
  await click("update every 10th row", "#update");
  await click("select row 2", "#tbody > tr:nth-child(2) a[data-action=select]");
  await click("swap rows", "#swaprows");
  await click("remove row 3", "#tbody > tr:nth-child(3) a[data-action=remove]");
  for (let count = 0; count < 20; count += 1) await press("#tbody > tr:nth-child(11) a[data-action=remove]");
  record("remove 20 rows");
  await click("append 1,000 rows", "#add");
  element.remove();
  await flush();
  main().append(element);
  await flush();
  record("reconnect");
  await click("update every 10th row again", "#update");
  await click("clear", "#clear");
  await click("create 10,000 rows", "#runlots");
  await click("swap 10,000 rows", "#swaprows");
  await click("clear 10,000 rows", "#clear");
  return { steps, warnings, errors };
};

window.mountBenchmark = async () => {
  const element = window.benchmark = create();
  main().append(element);
  await flush();
  return element;
};

// benchmark-app: one create/clear cycle for the forced-GC retention probe (experiment 006).
window.retentionCycle = async () => {
  const element = window.benchmark;
  element.querySelector("#run").click();
  await flush();
  (window.released ??= []).push(new WeakRef(element.querySelector("#tbody > tr")));
  element.querySelector("#clear").click();
  await flush();
};
