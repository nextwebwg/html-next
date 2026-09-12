import {
  scaffoldStencilComponent,
  type StencilComponentInventory,
  type StencilScaffoldDiagnostic,
} from "./stencil.js";

export interface LoomaMigration {
  readonly source: string;
  readonly controller?: string;
  readonly status: "ported" | "scaffold";
  readonly diagnostics: readonly StencilScaffoldDiagnostic[];
}

const PORTS: Readonly<Record<string, string>> = Object.freeze({
  "ui-badge": `<template component="ui-badge" status="early" summary="A compact status label.">
  <defs>
    <prop name="tone" type="string">Tone token.</prop>
    <prop name="variant" type="string">Variant token.</prop>
  </defs>
  <span class="badge__surface" :data-tone="tone" :data-variant="variant"><slot></slot></span>
</template>`,
  "ui-chip": `<template component="ui-chip" status="early" summary="A compact non-interactive metadata label.">
  <defs>
    <prop name="appearance" type="tag | pill" default="tag">Visual shape.</prop>
    <prop name="size" type="xs | sm" default="xs">Compact typography size.</prop>
  </defs>
  <span class="chip__surface" :data-appearance="appearance" :data-size="size"><span class="chip__label"><slot></slot></span></span>
</template>`,
  "ui-button": `<template component="ui-button" status="early" summary="A native button with Looma presentation.">
  <defs>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="size" type="string">Size token.</prop>
    <prop name="variant" type="outline | solid | destructive | ghost" default="outline">Visual treatment.</prop>
  </defs>
  <button type="button" :disabled="disabled" :data-size="size" :data-variant="variant"><slot></slot></button>
</template>`,
  "ui-floating-action-button": `<template component="ui-floating-action-button" status="early" summary="A floating native action button.">
  <defs>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="label" type="string" default="">Accessible label.</prop>
    <prop name="mobileOnly" type="boolean" default="false">Mobile-only presentation.</prop>
  </defs>
  <button type="button" :disabled="disabled" :aria-label="label" :data-mobile-only="mobileOnly"><slot></slot></button>
</template>`,
  "ui-icon-button": `<template component="ui-icon-button" status="early" summary="An icon-only native button.">
  <defs>
    <prop name="anticipatory" type="boolean" default="false">Affordance visibility.</prop>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="label" type="string" default="">Accessible label.</prop>
    <prop name="size" type="sm | md | lg" default="md">Control size.</prop>
    <prop name="variant" type="ghost | outline | solid" default="ghost">Visual treatment.</prop>
  </defs>
  <button type="button" :disabled="disabled" :aria-label="label" :data-anticipatory="anticipatory" :data-size="size" :data-variant="variant"><slot></slot></button>
</template>`,
  "ui-callout": `<template component="ui-callout" status="early" summary="A static semantic message with a tone-specific presentation.">
  <defs><prop name="tone" type="info | note | warning | success | error" default="info">Message tone.</prop></defs>
  <aside role="note" :data-tone="tone"><div class="callout__surface"><div class="content"><slot></slot></div></div></aside>
</template>`,
  "ui-search-shell": `<template component="ui-search-shell" status="early" summary="A structured search surface.">
  <div class="search-shell" part="base">
    <slot name="backdrop"></slot><div class="search-shell__panel" part="panel">
      <div class="search-shell__search" part="search"><slot name="search"></slot></div>
      <div class="search-shell__status" part="status"><slot name="status"></slot></div>
      <div class="search-shell__body" part="body"><slot name="body"></slot></div>
      <div class="search-shell__footer" part="footer"><slot name="footer"></slot></div>
    </div>
  </div>
</template>`,
  "ui-search-result-row": `<template component="ui-search-result-row" status="early" summary="A structured native search result button.">
  <defs>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="selected" type="boolean" default="false">Selected state.</prop>
  </defs>
  <button class="search-result-row" type="button" :disabled="disabled" :aria-selected="selected">
    <span class="search-result-row__leading"><slot name="leading"></slot></span>
    <span class="search-result-row__content"><span class="search-result-row__title"><slot name="title"></slot></span><span class="search-result-row__meta"><slot name="meta"></slot></span><span class="search-result-row__excerpt"><slot name="excerpt"></slot></span></span>
    <span class="search-result-row__trailing"><slot name="trailing"></slot></span>
  </button>
</template>`,
  "ui-top-bar": `<template component="ui-top-bar" status="early" summary="A semantic application top bar.">
  <header class="top-bar" part="base"><div class="top-bar__leading"><slot name="leading"></slot></div><div class="top-bar__title"><slot></slot></div><div class="top-bar__search"><slot name="search"></slot></div><div class="top-bar__actions"><slot name="actions"></slot></div></header>
</template>`,
  "ui-form-field": `<template component="ui-form-field" status="early" summary="A semantic field grouping surface.">
  <defs>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="label" type="string" default="">Field label.</prop>
    <prop name="required" type="boolean" default="false">Required state.</prop>
  </defs>
  <fieldset :disabled="disabled" :data-label="label" :data-required="required"><legend $value="label"></legend><slot></slot></fieldset>
</template>`,
  "ui-input": `<template component="ui-input" status="early" summary="A policy wrapper around a projected native input." controller="./ui-input.js">
  <defs>
    <prop name="defaultValue" type="string" default="">Initial uncontrolled value.</prop>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="invalid" type="boolean" default="false">Application validity state.</prop>
    <prop name="readOnly" type="boolean" default="false">Read-only state.</prop>
    <prop name="value" type="string?">Controlled value; absence leaves the input uncontrolled.</prop>
    <event name="input" type="object({ value: string, trigger: keyboard | pointer | programmatic })"></event>
    <event name="change" type="object({ value: string, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="input" :data-default-value="defaultValue" :data-disabled="disabled" :data-invalid="invalid" :data-readonly="readOnly" :data-value="value"><slot></slot></div>
</template>`,
  "ui-textarea": `<template component="ui-textarea" status="early" summary="A policy wrapper around a projected native textarea." controller="./ui-textarea.js">
  <defs>
    <prop name="defaultValue" type="string" default="">Initial uncontrolled value.</prop>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="invalid" type="boolean" default="false">Application validity state.</prop>
    <prop name="readOnly" type="boolean" default="false">Read-only state.</prop>
    <prop name="rows" type="integer" default="4">Visible text rows.</prop>
    <prop name="value" type="string?">Controlled value; absence leaves the textarea uncontrolled.</prop>
    <event name="input" type="object({ value: string, trigger: keyboard | pointer | programmatic })"></event>
    <event name="change" type="object({ value: string, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="textarea" :data-default-value="defaultValue" :data-disabled="disabled" :data-invalid="invalid" :data-readonly="readOnly" :data-rows="rows" :data-value="value"><slot></slot></div>
</template>`,
  "ui-select": `<template component="ui-select" status="early" summary="A policy wrapper around a projected native select." controller="./ui-select.js">
  <defs>
    <prop name="defaultValue" type="string?">Initial uncontrolled selection.</prop>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="invalid" type="boolean" default="false">Application validity state.</prop>
    <prop name="required" type="boolean" default="false">Required state.</prop>
    <prop name="value" type="string?">Controlled value; absence leaves the select uncontrolled.</prop>
    <event name="input" type="object({ value: string, trigger: keyboard | pointer | programmatic })"></event>
    <event name="change" type="object({ value: string, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="select" :data-default-value="defaultValue" :data-disabled="disabled" :data-invalid="invalid" :data-required="required" :data-value="value"><slot></slot></div>
</template>`,
  "ui-checkbox": `<template component="ui-checkbox" status="early" summary="A controlled or uncontrolled projected native checkbox." controller="./ui-checkbox.js">
  <defs>
    <prop name="checked" type="boolean?">Controlled checked state.</prop>
    <prop name="defaultChecked" type="boolean" default="false">Initial uncontrolled checked state.</prop>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="indeterminate" type="boolean" default="false">Mixed state.</prop>
    <prop name="required" type="boolean" default="false">Required state.</prop>
    <prop name="value" type="string" default="on">Submitted value.</prop>
    <event name="change" type="object({ checked: boolean, value: string, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="checkbox" role="checkbox" :data-checked="checked" :data-default-checked="defaultChecked" :data-disabled="disabled" :data-indeterminate="indeterminate" :data-required="required" :data-value="value"><slot></slot></div>
</template>`,
  "ui-radio": `<template component="ui-radio" status="early" summary="A controlled or uncontrolled projected native radio." controller="./ui-radio.js">
  <defs>
    <prop name="checked" type="boolean?">Controlled checked state.</prop>
    <prop name="defaultChecked" type="boolean" default="false">Initial uncontrolled checked state.</prop>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="name" type="string" default="">Native radio group name.</prop>
    <prop name="required" type="boolean" default="false">Required state.</prop>
    <prop name="value" type="string" default="on">Submitted value.</prop>
    <event name="change" type="object({ checked: boolean, value: string, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="radio" role="radio" :data-checked="checked" :data-default-checked="defaultChecked" :data-disabled="disabled" :data-name="name" :data-required="required" :data-value="value"><slot></slot></div>
</template>`,
  "ui-radio-group": `<template component="ui-radio-group" status="early" summary="A keyboard-navigable group of projected ui-radio controls." controller="./ui-radio-group.js">
  <defs>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="name" type="string" default="">Native radio group name.</prop>
    <prop name="orientation" type="horizontal | vertical" default="horizontal">Keyboard navigation axis.</prop>
    <prop name="required" type="boolean" default="false">Required state.</prop>
    <prop name="value" type="string" default="">Selected radio value.</prop>
    <event name="select" type="object({ value: string, previousValue: string, trigger: keyboard | pointer | programmatic })"></event>
    <event name="change" type="object({ checked: boolean, value: string, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="radio-group" role="radiogroup" :data-disabled="disabled" :data-name="name" :data-orientation="orientation" :data-required="required" :data-value="value"><slot></slot></div>
</template>`,
  "ui-switch": `<template component="ui-switch" status="early" summary="A native checkbox presented as a switch." controller="./ui-switch.js">
  <defs>
    <prop name="checked" type="boolean?">Controlled checked state.</prop>
    <prop name="defaultChecked" type="boolean" default="false">Initial uncontrolled checked state.</prop>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="required" type="boolean" default="false">Required state.</prop>
    <prop name="value" type="string" default="on">Submitted value.</prop>
    <event name="change" type="object({ checked: boolean, value: string, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <label class="switch" role="switch" tabindex="0" :data-checked="checked" :data-default-checked="defaultChecked" :data-disabled="disabled" :data-required="required" :data-value="value"><input $ref="control" type="checkbox" aria-hidden="true" tabindex="-1"><slot></slot></label>
</template>`,
});

const TRIGGER_OF = String.raw`function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}`;

const FORM_VALUE_CONTROLLER = String.raw`${TRIGGER_OF}
export default function controller(host) {
  const tag = host.element.getAttribute("data-component-root") || "";
  const kind = tag.includes("ui-textarea") ? "textarea" : tag.includes("ui-select") ? "select" : "input";
  let control;
  let initialized = false;
  const find = () => host.element.querySelector(kind);
  const sync = () => {
    control = find();
    if (!control) return;
    const controlled = host.state.value !== undefined;
    if (controlled) control.value = host.state.value;
    else if (!initialized && host.state.defaultValue !== undefined) control.value = host.state.defaultValue;
    if (kind !== "select") control.defaultValue = host.state.defaultValue || "";
    control.disabled = Boolean(host.state.disabled);
    if (kind === "textarea") {
      control.readOnly = Boolean(host.state.readOnly);
      control.rows = host.state.rows;
    } else if (kind === "input") control.readOnly = Boolean(host.state.readOnly);
    else control.required = Boolean(host.state.required);
    control.setAttribute("aria-invalid", host.state.invalid ? "true" : "false");
    host.element.toggleAttribute("data-invalid", Boolean(host.state.invalid));
    initialized = true;
  };
  const stop = host.effect(sync);
  const forward = (event) => {
    if (event.target !== control) return;
    const value = control.value;
    event.stopPropagation();
    host.dispatch(event.type, { value, trigger: triggerOf(event) });
    if (host.state.value !== undefined) queueMicrotask(sync);
  };
  host.element.addEventListener("input", forward);
  host.element.addEventListener("change", forward);
  const containsControl = (node) => node.nodeType === Node.ELEMENT_NODE &&
    (node.matches?.(kind) || node.querySelector?.(kind));
  const observer = new MutationObserver((records) => {
    if (!control?.isConnected || records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(containsControl))) sync();
  });
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); host.element.removeEventListener("input", forward); host.element.removeEventListener("change", forward); };
}`;

const TOGGLE_CONTROLLER = String.raw`${TRIGGER_OF}
export default function controller(host) {
  const isRadio = (host.element.getAttribute("data-component-root") || "").includes("ui-radio");
  const selector = isRadio ? 'input[type="radio"]' : 'input[type="checkbox"]';
  let control;
  let initialized = false;
  let internal = false;
  const find = () => host.element.querySelector(selector);
  const sync = () => {
    control = find();
    if (!control) return;
    const controlled = host.state.checked !== undefined;
    if (!initialized) internal = controlled ? Boolean(host.state.checked) : Boolean(host.state.defaultChecked);
    else if (controlled) internal = Boolean(host.state.checked);
    control.checked = internal;
    control.disabled = Boolean(host.state.disabled);
    control.required = Boolean(host.state.required);
    control.value = host.state.value;
    if (isRadio) control.name = host.state.name;
    else control.indeterminate = Boolean(host.state.indeterminate);
    host.element.setAttribute("aria-checked", !isRadio && host.state.indeterminate ? "mixed" : String(internal));
    host.element.setAttribute("aria-disabled", String(Boolean(host.state.disabled)));
    host.element.toggleAttribute("data-disabled", Boolean(host.state.disabled));
    initialized = true;
  };
  const stop = host.effect(sync);
  const changed = (event) => {
    if (event.target !== control || (isRadio && !control.checked)) return;
    const checked = control.checked;
    if (host.state.checked === undefined) internal = checked;
    event.stopPropagation();
    sync();
    host.dispatch("change", { checked, value: host.state.value, trigger: triggerOf(event) });
  };
  host.element.addEventListener("change", changed);
  const containsControl = (node) => node.nodeType === Node.ELEMENT_NODE &&
    (node.matches?.(selector) || node.querySelector?.(selector));
  const observer = new MutationObserver((records) => {
    if (!control?.isConnected || records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(containsControl))) sync();
  });
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); host.element.removeEventListener("change", changed); };
}`;

const SWITCH_CONTROLLER = String.raw`${TRIGGER_OF}
export default function controller(host) {
  const control = host.refs.control;
  let initialized = false;
  let internal = false;
  const sync = () => {
    const controlled = host.state.checked !== undefined;
    if (!initialized) internal = controlled ? Boolean(host.state.checked) : Boolean(host.state.defaultChecked);
    else if (controlled) internal = Boolean(host.state.checked);
    control.checked = internal;
    control.disabled = Boolean(host.state.disabled);
    control.required = Boolean(host.state.required);
    control.value = host.state.value;
    host.element.setAttribute("aria-checked", String(internal));
    host.element.setAttribute("aria-disabled", String(Boolean(host.state.disabled)));
    host.element.tabIndex = host.state.disabled ? -1 : 0;
    host.element.toggleAttribute("data-disabled", Boolean(host.state.disabled));
    initialized = true;
  };
  const stop = host.effect(sync);
  const changed = (event) => {
    if (event.target !== control) return;
    const checked = control.checked;
    if (host.state.checked === undefined) internal = checked;
    event.stopPropagation();
    sync();
    host.dispatch("change", { checked, value: host.state.value, trigger: triggerOf(event) });
  };
  const keydown = (event) => {
    if (event.key !== " " || host.state.disabled) return;
    event.preventDefault();
    control.click();
  };
  host.element.addEventListener("change", changed);
  host.element.addEventListener("keydown", keydown);
  return () => { stop(); host.element.removeEventListener("change", changed); host.element.removeEventListener("keydown", keydown); };
}`;

const RADIO_GROUP_CONTROLLER = String.raw`export default function controller(host) {
  let current = host.state.value || "";
  let lastControlledValue = current;
  const radios = () => Array.from(host.element.querySelectorAll('[data-component-root~="ui-radio"]'));
  const native = (radio) => radio.querySelector('input[type="radio"]');
  const apply = () => {
    const items = radios();
    const selected = items.findIndex((radio) => radio.value === current);
    items.forEach((radio, index) => {
      radio.checked = radio.value === current;
      radio.name = host.state.name || host.element.id || "ui-radio-group";
      radio.disabled = Boolean(host.state.disabled);
      radio.required = Boolean(host.state.required);
      const input = native(radio);
      if (input) input.tabIndex = index === (selected < 0 ? 0 : selected) ? 0 : -1;
    });
    host.element.setAttribute("aria-orientation", host.state.orientation);
    host.element.toggleAttribute("data-disabled", Boolean(host.state.disabled));
  };
  const stop = host.effect(() => {
    const controlledValue = host.state.value || "";
    if (controlledValue !== lastControlledValue) {
      current = controlledValue;
      lastControlledValue = controlledValue;
    }
    apply();
  });
  const select = (value, trigger) => {
    if (!value || value === current || host.state.disabled) return;
    const previousValue = current;
    current = value;
    apply();
    host.dispatch("select", { value, previousValue, trigger });
    host.dispatch("change", { checked: true, value, trigger });
  };
  const change = (event) => {
    const radio = event.target.closest?.('[data-component-root~="ui-radio"]');
    if (!radio || !host.element.contains(radio) || event.detail?.checked !== true) return;
    event.stopPropagation();
    select(radio.value, event.detail.trigger || "programmatic");
  };
  const keydown = (event) => {
    const items = radios().filter((radio) => !radio.disabled);
    if (items.length === 0) return;
    const vertical = host.state.orientation === "vertical";
    const previous = vertical ? event.key === "ArrowUp" : event.key === "ArrowLeft";
    const next = vertical ? event.key === "ArrowDown" : event.key === "ArrowRight";
    if (!previous && !next) return;
    event.preventDefault();
    const at = Math.max(0, items.findIndex((radio) => radio.value === current));
    const index = previous ? (at - 1 + items.length) % items.length : (at + 1) % items.length;
    select(items[index].value, "keyboard");
    native(items[index])?.focus();
  };
  host.element.addEventListener("change", change);
  host.element.addEventListener("keydown", keydown);
  const containsRadio = (node) => node.nodeType === Node.ELEMENT_NODE &&
    (node.matches?.('[data-component-root~="ui-radio"]') || node.querySelector?.('[data-component-root~="ui-radio"]'));
  const observer = new MutationObserver((records) => {
    if (records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(containsRadio))) apply();
  });
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); host.element.removeEventListener("change", change); host.element.removeEventListener("keydown", keydown); };
}`;

const CONTROLLERS: Readonly<Record<string, string>> = Object.freeze({
  "ui-input": FORM_VALUE_CONTROLLER,
  "ui-textarea": FORM_VALUE_CONTROLLER,
  "ui-select": FORM_VALUE_CONTROLLER,
  "ui-checkbox": TOGGLE_CONTROLLER,
  "ui-radio": TOGGLE_CONTROLLER,
  "ui-radio-group": RADIO_GROUP_CONTROLLER,
  "ui-switch": SWITCH_CONTROLLER,
});

export function migrateLoomaComponent(component: StencilComponentInventory): LoomaMigration {
  const port = PORTS[component.tag];
  if (port !== undefined) return Object.freeze({
    source: `${port}\n`,
    ...(CONTROLLERS[component.tag] === undefined ? {} : { controller: `${CONTROLLERS[component.tag]}\n` }),
    status: "ported",
    diagnostics: Object.freeze([]),
  });
  const scaffold = scaffoldStencilComponent(component);
  return Object.freeze({ source: scaffold.source, status: "scaffold", diagnostics: scaffold.diagnostics });
}

export const LOOMA_PORTED_TAGS = Object.freeze(Object.keys(PORTS).sort());
