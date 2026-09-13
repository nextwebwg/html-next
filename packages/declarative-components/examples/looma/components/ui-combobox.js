import { createAnchoredSurface, createOverlay } from "./overlay.js";

const instances = new WeakMap();

function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}

async function validationResult(raw, selected, config, signal) {
  let output = raw;
  let issues = [];
  const request = { raw, value: selected, context: config.context, signal };
  signal.throwIfAborted();
  try {
    if (config.parse) output = await config.parse(raw, request);
    signal.throwIfAborted();
    if (config.schema) {
      const result = await config.schema["~standard"].validate(output);
      signal.throwIfAborted();
      if (result.issues) issues.push(...result.issues);
      else if ("value" in result) output = result.value;
    }
    if (!issues.some((issue) => issue.severity !== "warning")) {
      if (config.normalize) output = await config.normalize(output, request);
      signal.throwIfAborted();
      if (config.validator) {
        const result = await config.validator(output, request);
        signal.throwIfAborted();
        issues.push(...(result.issues || []));
        if ("output" in result) output = result.output;
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    issues.push({ message: error instanceof Error ? error.message : "Unable to validate this value." });
  }
  issues.push(...(config.issues || []));
  return { output: issues.some((issue) => issue.severity !== "warning") ? undefined : output, issues };
}

export default function controller(host) {
  const input = host.refs.input;
  const label = host.refs.label;
  const field = host.refs.field;
  const popup = host.refs.popup;
  const clear = host.refs.clear;
  const disclosure = host.refs.disclosure;
  const validation = host.refs.validation;
  const surface = createAnchoredSurface(popup, field, "bottom-start");
  let overlay;
  let lookup;
  let lookupTimer;
  let validationRun;
  let initialized = false;
  let raw = "";
  let selected = null;
  let active = -1;
  let expanded = false;
  let initialRaw = "";
  let lastConfig;

  const config = () => host.state.config || {};
  const renderInput = () => {
    input.value = raw;
    input.placeholder = host.state.placeholder;
    input.name = host.state.name;
    input.disabled = Boolean(host.state.disabled);
    input.readOnly = Boolean(host.state.readOnly);
    input.required = Boolean(host.state.required);
    input.setAttribute("aria-expanded", String(expanded));
    input.setAttribute("aria-controls", input.id + "-listbox");
    input.setAttribute("aria-activedescendant", expanded && active >= 0 ? input.id + "-option-" + active : "");
    label.htmlFor = input.id;
    label.classList.toggle("sr-only", host.state.labelVisibility === "sr-only");
    clear.hidden = !host.state.clearable || !raw;
    clear.disabled = Boolean(host.state.disabled || host.state.readOnly);
    clear.setAttribute("aria-label", "Clear " + (host.state.label || "field"));
    disclosure.hidden = !host.state.disclosure;
    disclosure.disabled = Boolean(host.state.disabled || host.state.readOnly);
    disclosure.setAttribute("aria-expanded", String(expanded));
    popup.hidden = !expanded;
    host.element.setAttribute("data-state", expanded ? "open" : "closed");
  };
  const updateActive = () => {
    const options = popup.querySelectorAll('[role="option"]');
    options.forEach((option, index) => {
      option.toggleAttribute("data-active", index === active);
      option.setAttribute("aria-selected", String(host.state.rows[index]?.value === selected));
      if (!option.id) option.id = input.id + "-option-" + index;
    });
    renderInput();
  };
  const close = () => {
    expanded = false;
    active = -1;
    clearTimeout(lookupTimer);
    lookup?.abort();
    lookup = undefined;
    overlay?.destroy();
    overlay = undefined;
    surface.hide();
    renderInput();
  };
  const setRows = (rows) => {
    const ids = new Set();
    const lower = raw.toLocaleLowerCase();
    const filtered = rows.filter((row) => {
      if (!row || ids.has(row.id)) return false;
      ids.add(row.id);
      return config().filter ? config().filter(row, raw, config().context) : row.label.toLocaleLowerCase().includes(lower);
    });
    host.state.rows = filtered;
    host.state.canCreate = Boolean(config().allowCreate && raw.trim() && !filtered.some((row) => row.label.toLocaleLowerCase() === lower));
    host.state.loading = false;
    host.dispatch("options-change", filtered);
    queueMicrotask(updateActive);
  };
  const search = (reason = "input") => {
    clearTimeout(lookupTimer);
    lookup?.abort();
    lookup = new AbortController();
    const current = lookup;
    const policy = config();
    const query = reason === "disclosure" ? "" : raw;
    host.state.lookupError = "";
    if (!policy.provider) { setRows(policy.options || []); return; }
    host.state.loading = true;
    host.state.rows = [];
    lookupTimer = setTimeout(async () => {
      try {
        const rows = await policy.provider({ query, context: policy.context, signal: current.signal, reason });
        if (!current.signal.aborted) setRows(rows);
      } catch (error) {
        if (current.signal.aborted) return;
        host.state.loading = false;
        host.state.lookupError = error instanceof Error ? error.message : "Unable to load suggestions.";
      }
    }, reason === "disclosure" ? 0 : Math.max(0, policy.debounce ?? 200));
  };
  const open = (reason = "input") => {
    if (host.state.disabled || host.state.readOnly) return;
    expanded = true;
    popup.style.minWidth = field.getBoundingClientRect().width + "px";
    surface.show();
    overlay?.destroy();
    overlay = createOverlay(popup, { relatedElements: [host.element], requestClose: close });
    overlay.open();
    renderInput();
    search(reason);
  };
  const setQuery = (next, trigger) => {
    raw = next;
    host.state.raw = raw;
    if (host.state.query === undefined) input.value = raw;
    host.dispatch("query-change", { query: raw, display: raw, trigger });
  };
  const commit = (value, query, option, kind, trigger) => {
    if (host.state.value === undefined) selected = value;
    if (host.state.query === undefined) setQuery(query, trigger);
    const detail = { value, query, option, kind, trigger };
    host.dispatch("value-change", detail);
    if (kind === "create") host.dispatch("create-entry", detail);
    if (kind === "free-entry") host.dispatch("free-entry", detail);
    if (kind === "invalidation") host.dispatch("dependency-invalidate", detail);
  };
  const choose = (index, trigger) => {
    const option = host.state.rows[index];
    if (option?.disabled) return;
    if (option) commit(option.value, option.label, option, "selection", trigger);
    else if (host.state.canCreate && index === host.state.rows.length) commit(null, raw, null, "create", trigger);
    else return;
    close();
    input.focus();
  };
  const move = (key) => {
    const enabled = host.state.rows.flatMap((row, index) => row.disabled ? [] : [index]);
    if (host.state.canCreate) enabled.push(host.state.rows.length);
    if (!enabled.length) return;
    const current = enabled.indexOf(active);
    active = key === "Home" ? enabled[0] : key === "End" ? enabled.at(-1)
      : key === "ArrowDown" ? enabled[Math.min(current + 1, enabled.length - 1)]
      : enabled[current < 0 ? enabled.length - 1 : Math.max(0, current - 1)];
    updateActive();
  };
  const runValidation = async () => {
    validationRun?.abort();
    validationRun = new AbortController();
    const state = { status: "pending", touched: true, dirty: raw !== initialRaw, issues: [] };
    host.dispatch("validation-change", state);
    let result;
    try { result = await validationResult(raw, selected, config(), validationRun.signal); }
    catch { return state; }
    const issues = [...result.issues];
    if (host.state.required && !raw.trim()) issues.push({ message: "A value is required." });
    else if (raw && selected === null && !config().allowFreeText && !config().allowCreate) issues.push({ message: "Choose a suggestion." });
    const blocking = issues.some((issue) => issue.severity !== "warning");
    const next = { status: blocking ? "error" : issues.length ? "warning" : "valid", touched: true, dirty: raw !== initialRaw, issues, output: blocking ? undefined : result.output };
    input.setCustomValidity(blocking ? issues.find((issue) => issue.severity !== "warning")?.message || "Invalid value." : "");
    input.setAttribute("aria-invalid", String(blocking));
    validation.textContent = issues.map((issue) => issue.message).join(" ");
    host.dispatch("validation-change", next);
    return next;
  };
  const apply = () => {
    const valueControlled = host.state.value !== undefined;
    const queryControlled = host.state.query !== undefined;
    if (!initialized) {
      selected = valueControlled ? host.state.value : host.state.defaultValue ?? null;
      raw = queryControlled ? host.state.query : host.state.defaultQuery;
      if (!raw && selected !== null) raw = config().options?.find((row) => row.value === selected)?.label ?? selected;
      initialRaw = raw;
      input.id ||= "combobox-" + Math.random().toString(36).slice(2);
    } else {
      if (valueControlled) selected = host.state.value;
      if (queryControlled) raw = host.state.query;
      if (lastConfig !== config() && expanded) search("context");
    }
    lastConfig = config();
    host.state.raw = raw;
    renderInput();
    if ((host.state.disabled || host.state.readOnly) && expanded) close();
    initialized = true;
  };
  const stop = host.effect(apply);
  const onInput = (event) => {
    const previous = selected;
    setQuery(input.value, triggerOf(event));
    if (previous !== null) commit(null, raw, null, "clear", triggerOf(event));
    open();
    if (config().validateOn === "input") runValidation();
  };
  const keydown = (event) => {
    if (event.isComposing || host.state.disabled || host.state.readOnly) return;
    if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "Tab") close();
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!expanded) open("disclosure"); move(event.key); }
    else if ((event.key === "Home" || event.key === "End") && expanded) { event.preventDefault(); move(event.key); }
    else if (event.key === "Enter" && expanded) {
      if (active >= 0) { event.preventDefault(); choose(active, "keyboard"); }
      else if (config().allowFreeText) { event.preventDefault(); commit(null, raw, null, "free-entry", "keyboard"); close(); }
    }
  };
  const optionClick = (event) => {
    const option = event.target.closest?.('[role="option"][data-index]');
    if (option && popup.contains(option)) choose(Number(option.dataset.index), triggerOf(event));
  };
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", keydown);
  input.addEventListener("blur", () => { if ((config().validateOn ?? "blur") === "blur") runValidation(); });
  popup.addEventListener("pointerdown", (event) => event.preventDefault());
  popup.addEventListener("click", optionClick);
  clear.addEventListener("click", () => { commit(null, "", null, "clear", "pointer"); close(); input.focus(); });
  disclosure.addEventListener("click", () => { if (expanded) close(); else open("disclosure"); input.focus(); });
  const api = { focusInput: () => input.focus(), validate: runValidation };
  instances.set(host.element, api);
  return () => { stop(); close(); surface.destroy(); validationRun?.abort(); instances.delete(host.element); };
}

export async function focusInput(host) { instances.get(host.element)?.focusInput(); }
export async function validate(host) {
  const api = instances.get(host.element);
  if (!api) throw new TypeError("Combobox is not connected.");
  return api.validate();
}
