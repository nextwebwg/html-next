import { createAnchoredSurface, createOverlay } from "./overlay.js";

const instances = new WeakMap();

function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}

export default function controller(host) {
  const input = host.refs.input;
  const label = host.refs.label;
  const field = host.refs.field;
  const popup = host.refs.popup;
  const surface = createAnchoredSurface(popup, field, "bottom-start");
  let overlay;
  let lookup;
  let timer;
  let initialized = false;
  let raw = "";
  let active = -1;
  let expanded = false;

  const config = () => host.state.config || {};
  const selectedItems = () => Array.isArray(host.state.items) ? host.state.items : [];
  const syncNative = () => {
    input.value = raw;
    input.placeholder = host.state.placeholder;
    input.disabled = Boolean(host.state.disabled);
    input.readOnly = Boolean(host.state.readOnly);
    input.required = Boolean(host.state.required && selectedItems().length === 0);
    input.setAttribute("aria-expanded", String(expanded));
    input.setAttribute("aria-controls", input.id + "-listbox");
    input.setAttribute("aria-activedescendant", expanded && active >= 0 ? input.id + "-option-" + active : "");
    label.htmlFor = input.id;
    popup.hidden = !expanded;
    host.element.setAttribute("data-state", expanded ? "open" : "closed");
    queueMicrotask(() => {
      popup.querySelectorAll('[role="option"]').forEach((option, index) => {
        option.toggleAttribute("data-active", index === active);
        option.id ||= input.id + "-option-" + index;
      });
      host.element.querySelectorAll(".multi-combobox__item").forEach((item, index) => {
        const value = selectedItems()[index];
        item.disabled = Boolean(host.state.disabled || host.state.readOnly || value?.disabled);
        item.setAttribute("aria-label", (value?.label || "Item") + ", press Delete or Backspace to remove");
        item.tabIndex = -1;
      });
    });
  };
  const close = () => {
    expanded = false;
    active = -1;
    clearTimeout(timer);
    lookup?.abort();
    lookup = undefined;
    overlay?.destroy();
    overlay = undefined;
    surface.hide();
    syncNative();
  };
  const setRows = (rows) => {
    const selected = new Set(selectedItems().map((item) => item.value));
    const lower = raw.toLocaleLowerCase();
    host.state.rows = rows.filter((row) => !selected.has(row.value) && !row.disabled &&
      (config().filter ? config().filter(row, raw, config().context) : row.label.toLocaleLowerCase().includes(lower)));
    host.state.canCreate = Boolean(config().allowCreate && raw.trim() &&
      !host.state.rows.some((row) => row.label.toLocaleLowerCase() === lower));
    host.state.loading = false;
    host.dispatch("options-change", host.state.rows);
    syncNative();
  };
  const search = () => {
    clearTimeout(timer);
    lookup?.abort();
    lookup = new AbortController();
    const current = lookup;
    host.state.lookupError = "";
    if (!config().provider) { setRows(config().options || []); return; }
    host.state.loading = true;
    host.state.rows = [];
    timer = setTimeout(async () => {
      try {
        const rows = await config().provider({ query: raw, context: config().context, signal: current.signal, reason: "input" });
        if (!current.signal.aborted) setRows(rows);
      } catch (error) {
        if (!current.signal.aborted) {
          host.state.loading = false;
          host.state.lookupError = error instanceof Error ? error.message : "Unable to load suggestions.";
        }
      }
    }, Math.max(0, config().debounce ?? 200));
  };
  const open = () => {
    if (host.state.disabled || host.state.readOnly) return;
    expanded = true;
    surface.show();
    overlay?.destroy();
    overlay = createOverlay(popup, { relatedElements: [host.element], requestClose: close });
    overlay.open();
    syncNative();
    search();
  };
  const setQuery = (next, trigger) => {
    raw = next;
    host.state.raw = raw;
    input.value = raw;
    host.dispatch("query-change", { query: raw, display: raw, trigger });
  };
  const add = (option, trigger) => {
    host.dispatch("add-item", { item: option, index: selectedItems().length, trigger });
    setQuery("", trigger);
    close();
    input.focus();
  };
  const create = (trigger) => {
    const query = raw.trim();
    if (!query) return;
    host.dispatch("create-item", { query, trigger });
    setQuery("", trigger);
    close();
    input.focus();
  };
  const choose = (index, trigger) => {
    const option = host.state.rows[index];
    if (option) add(option, trigger);
    else if (host.state.canCreate && index === host.state.rows.length) create(trigger);
  };
  const remove = (index, trigger) => {
    const item = selectedItems()[index];
    if (!item || item.disabled || host.state.disabled || host.state.readOnly) return;
    host.dispatch("remove-item", { item, index, trigger });
    requestAnimationFrame(() => {
      const buttons = host.element.querySelectorAll(".multi-combobox__item");
      (buttons[Math.min(index, buttons.length - 1)] || buttons[index - 1] || input).focus();
    });
  };
  const move = (key) => {
    const count = host.state.rows.length + (host.state.canCreate ? 1 : 0);
    if (!count) return;
    active = key === "Home" ? 0 : key === "End" ? count - 1
      : key === "ArrowDown" ? Math.min(active + 1, count - 1)
      : active < 0 ? count - 1 : Math.max(0, active - 1);
    syncNative();
  };
  const commitQuery = (trigger) => {
    const normalized = raw.trim().toLocaleLowerCase();
    if (!normalized) return;
    const option = host.state.rows.find((row) => row.label.trim().toLocaleLowerCase() === normalized);
    if (option) add(option, trigger);
    else if (config().allowCreate) create(trigger);
  };
  const apply = () => {
    if (!initialized) {
      raw = host.state.query ?? host.state.defaultQuery;
      input.id ||= "multi-combobox-" + Math.random().toString(36).slice(2);
    } else if (host.state.query !== undefined) raw = host.state.query;
    host.state.raw = raw;
    syncNative();
    initialized = true;
  };
  const stop = host.effect(apply);
  input.addEventListener("input", (event) => { setQuery(input.value, triggerOf(event)); open(); });
  input.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || host.state.disabled || host.state.readOnly) return;
    if ((host.state.tokenSeparators || []).includes(event.key)) { event.preventDefault(); commitQuery("keyboard"); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!expanded) open(); move(event.key); }
    else if ((event.key === "Home" || event.key === "End") && expanded) { event.preventDefault(); move(event.key); }
    else if (event.key === "Enter" && expanded && active >= 0) { event.preventDefault(); choose(active, "keyboard"); }
    else if (event.key === "Escape") close();
    else if (!raw && event.key === "Backspace" && selectedItems().length) { event.preventDefault(); remove(selectedItems().length - 1, "keyboard"); }
    else if (!raw && event.key === "ArrowLeft" && selectedItems().length) {
      event.preventDefault(); host.element.querySelectorAll(".multi-combobox__item")[selectedItems().length - 1]?.focus();
    }
  });
  popup.addEventListener("pointerdown", (event) => event.preventDefault());
  popup.addEventListener("click", (event) => {
    const option = event.target.closest?.('[role="option"][data-index]');
    if (option && popup.contains(option)) choose(Number(option.dataset.index), triggerOf(event));
  });
  host.element.addEventListener("keydown", (event) => {
    const item = event.target.closest?.(".multi-combobox__item");
    if (!item || !host.element.contains(item)) return;
    const buttons = Array.from(host.element.querySelectorAll(".multi-combobox__item"));
    const index = buttons.indexOf(item);
    if (event.key === "ArrowLeft") { event.preventDefault(); (buttons[Math.max(0, index - 1)] || item).focus(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); (buttons[index + 1] || input).focus(); }
    else if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); remove(index, "keyboard"); }
  });
  host.element.addEventListener("click", (event) => {
    const item = event.target.closest?.(".multi-combobox__item");
    if (item && host.element.contains(item)) remove(Array.from(host.element.querySelectorAll(".multi-combobox__item")).indexOf(item), triggerOf(event));
  });
  instances.set(host.element, { focusInput: () => input.focus() });
  return () => { stop(); close(); surface.destroy(); instances.delete(host.element); };
}

export async function focusInput(host) { instances.get(host.element)?.focusInput(); }
