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
  "ui-avatar": `<template component="ui-avatar" status="early" summary="An image avatar with a generated text fallback." controller="./ui-avatar.js">
  <defs>
    <prop name="alt" type="string" default="">Alternative text.</prop>
    <prop name="fallback" type="string" default="">Explicit fallback text.</prop>
    <prop name="name" type="string" default="">Person name used for labeling and initials.</prop>
    <prop name="src" type="string" default="">Image source resolved by the native image element.</prop>
  </defs>
  <div class="avatar" role="img" :data-alt="alt" :data-fallback="fallback" :data-name="name" :data-src="src"><img $ref="image" alt="" hidden aria-hidden="true"><span $ref="fallback" class="fallback" aria-hidden="false"></span></div>
</template>`,
  "ui-avatar-group": `<template component="ui-avatar-group" status="early" summary="A labeled avatar group with an overflow count." controller="./ui-avatar-group.js">
  <defs>
    <prop name="label" type="string" default="People">Accessible group label.</prop>
    <prop name="max" type="number" default="5">Maximum visible avatars.</prop>
  </defs>
  <div class="avatar-group" role="group" :aria-label="label" :data-max="max"><slot></slot></div>
</template>`,
  "ui-menu-item": `<template component="ui-menu-item" status="early" summary="A native menu action.">
  <defs>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="value" type="string" default="">Action value.</prop>
  </defs>
  <button class="menu-item" type="button" role="menuitem" :disabled="disabled" :data-value="value"><span class="menu-item__surface"><slot></slot></span></button>
</template>`,
  "ui-menu": `<template component="ui-menu" status="early" summary="An anchored menu of native actions." controller="./ui-menu.js">
  <defs>
    <prop name="open" type="boolean?">Controlled open state.</prop>
    <prop name="defaultOpen" type="boolean" default="false">Initial uncontrolled open state.</prop>
    <prop name="for" type="string?">Id of the anchor element.</prop>
    <prop name="placement" type="bottom-start | bottom-end | top-start | top-end" default="bottom-start">Preferred anchored placement.</prop>
    <event name="select" type="object({ value: string, trigger: keyboard | pointer | programmatic })"></event>
    <event name="close" type="object({ open: boolean, reason: action | programmatic | light-dismiss | escape, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="menu__surface" role="menu" aria-orientation="vertical" :data-open="open" :data-default-open="defaultOpen" :data-for="for" :data-placement="placement"><slot></slot></div>
</template>`,
  "ui-context-menu": `<template component="ui-context-menu" status="early" summary="A point-positioned contextual menu." controller="./ui-context-menu.js">
  <defs>
    <prop name="open" type="boolean?">Controlled open state.</prop>
    <prop name="defaultOpen" type="boolean" default="false">Initial uncontrolled open state.</prop>
    <prop name="for" type="string?">Id of the context target.</prop>
    <event name="open" type="object({ open: boolean, reason: action | programmatic, trigger: keyboard | pointer | programmatic })"></event>
    <event name="close" type="object({ open: boolean, reason: action | programmatic | light-dismiss | escape, trigger: keyboard | pointer | programmatic })"></event>
    <event name="select" type="object({ value: string, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="context-menu" :data-open="open" :data-default-open="defaultOpen" :data-for="for"><slot name="trigger"></slot><div $ref="surface" class="context-menu__surface" data-context-menu-surface role="menu" aria-orientation="vertical"><slot></slot></div></div>
</template>`,
  "ui-disclosure": `<template component="ui-disclosure" status="early" summary="A controlled or uncontrolled disclosure over projected trigger and content." controller="./ui-disclosure.js">
  <defs>
    <prop name="open" type="boolean?">Controlled open state.</prop>
    <prop name="defaultOpen" type="boolean" default="false">Initial uncontrolled open state.</prop>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <event name="open" type="object({ open: boolean, reason: action | programmatic | light-dismiss | escape, trigger: keyboard | pointer | programmatic })"></event>
    <event name="close" type="object({ open: boolean, reason: action | programmatic | light-dismiss | escape, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="disclosure" :data-open="open" :data-default-open="defaultOpen" :data-disabled="disabled"><slot></slot></div>
</template>`,
  "ui-tabs": `<template component="ui-tabs" status="early" summary="A controlled or uncontrolled projected tab set." controller="./ui-tabs.js">
  <defs>
    <prop name="value" type="string?">Controlled selected tab identifier.</prop>
    <prop name="defaultValue" type="string" default="">Initial uncontrolled tab identifier.</prop>
    <prop name="orientation" type="horizontal | vertical" default="horizontal">Keyboard navigation axis.</prop>
    <event name="select" type="object({ value: string, previousValue?: string, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="tabs" :data-value="value" :data-default-value="defaultValue" :data-orientation="orientation"><slot></slot></div>
</template>`,
  "ui-editable": `<template component="ui-editable" status="early" summary="Swaps an explicit presentation trigger for a focused editing control." controller="./ui-editable.js">
  <defs>
    <prop name="edit" type="boolean?">Controlled edit state.</prop>
    <prop name="defaultEdit" type="boolean" default="false">Initial uncontrolled edit state.</prop>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <event name="edit-change" type="object({ edit: boolean, reason: activate | escape | light-dismiss | programmatic, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="editable" :data-edit="edit" :data-default-edit="defaultEdit" :data-disabled="disabled"><div $ref="preview" class="editable__preview"><slot name="preview"></slot></div><div $ref="editor" class="editable__editor"><slot name="edit"></slot></div></div>
</template>`,
  "ui-combobox": `<template component="ui-combobox" status="early" summary="A native editable field with async, data-derived suggestions and validation." controller="./ui-combobox.js">
  <defs>
    <prop name="clearable" type="boolean" default="false">Whether the selection may be cleared with an affordance.</prop>
    <prop name="config" type="unknown">Options, provider, filtering, formatting, and validation policy.</prop>
    <prop name="defaultQuery" type="string" default="">Initial uncontrolled editing text.</prop>
    <prop name="defaultValue" type="string?">Initial uncontrolled canonical value.</prop>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="disclosure" type="boolean" default="false">Whether to show the full-set disclosure affordance.</prop>
    <prop name="help" type="string" default="">Connected field help.</prop>
    <prop name="label" type="string" default="">Visible and accessible label.</prop>
    <prop name="labelVisibility" type="visible | sr-only" default="visible">Label presentation.</prop>
    <prop name="name" type="string" default="">Native submitted field name.</prop>
    <prop name="placeholder" type="string" default="">Native input placeholder.</prop>
    <prop name="query" type="string?">Controlled raw editing text.</prop>
    <prop name="readOnly" type="boolean" default="false">Read-only state.</prop>
    <prop name="required" type="boolean" default="false">Native required constraint.</prop>
    <prop name="size" type="sm | md" default="md">Control size.</prop>
    <prop name="value" type="string?">Controlled canonical value.</prop>
    <state name="rows" :value="[]"></state><state name="loading" :value="false"></state><state name="lookupError" :value="''"></state><state name="canCreate" :value="false"></state><state name="raw" :value="''"></state>
    <event name="create-entry" type="object({ value: string?, query: string, option: unknown, kind: create, trigger: keyboard | pointer | programmatic })"></event>
    <event name="dependency-invalidate" type="unknown"></event>
    <event name="free-entry" type="unknown"></event>
    <event name="options-change" type="list(unknown)"></event>
    <event name="query-change" type="object({ query: string, display: string, trigger: keyboard | pointer | programmatic })"></event>
    <event name="validation-change" type="object({ status: pristine | pending | valid | warning | error, touched: boolean, dirty: boolean, issues: list(unknown), output: unknown })"></event>
    <event name="value-change" type="object({ value: string?, query: string, option: unknown, kind: selection | clear | free-entry | create | invalidation, trigger: keyboard | pointer | programmatic })"></event>
    <method name="focusInput" export="focusInput" returns="promise(absent)"></method><method name="validate" export="validate" returns="promise(unknown)"></method>
  </defs>
  <div class="combobox" .config="config" :data-clearable="clearable" :data-default-query="defaultQuery" :data-default-value="defaultValue" :data-disabled="disabled" :data-disclosure="disclosure" :data-help="help" :data-label="label" :data-label-visibility="labelVisibility" :data-name="name" :data-placeholder="placeholder" :data-query="query" :data-read-only="readOnly" :data-required="required" :data-size="size" :data-value="value">
    <label $ref="label" class="combobox__label"><span $value="label"></span></label><div $ref="field" class="combobox__field"><slot name="start"></slot><input $ref="input" type="text" role="combobox" aria-autocomplete="list" autocomplete="off"><button $ref="clear" class="combobox__clear" type="button">Clear</button><button $ref="disclosure" class="combobox__disclosure" type="button">Suggestions</button></div>
    <div $ref="popup" class="combobox__popup"><div role="listbox" class="combobox__listbox"><div class="combobox__option" role="option" $each="row, i of rows" $key="row.id" :data-index="i" :aria-disabled="row.disabled"><slot :name="format('option-%s', row.id)"><span $value="row.label"></span></slot></div><div class="combobox__option combobox__create" role="option" $if="canCreate" :data-index="rows.length"><slot name="create"><span>Create “</span><span $value="raw"></span><span>”</span></slot></div></div><div class="combobox__message" $if="loading"><slot name="loading">Loading suggestions…</slot></div><div class="combobox__message" $if="lookupError"><slot name="error"><span $value="lookupError"></span></slot></div><div class="combobox__message" $if="not loading and not lookupError and rows.length = 0 and not canCreate"><slot name="empty">No suggestions.</slot></div><slot name="footer"></slot></div>
    <div $ref="validation" class="combobox__validation" aria-live="polite"></div>
  </div>
</template>`,
  "ui-multi-combobox": `<template component="ui-multi-combobox" status="early" summary="A native multi-value combobox with removable data-derived items." controller="./ui-multi-combobox.js">
  <defs>
    <prop name="config" type="unknown">Options, provider, filtering, and creation policy.</prop><prop name="defaultQuery" type="string" default="">Initial uncontrolled query.</prop><prop name="disabled" type="boolean" default="false">Disabled state.</prop><prop name="items" type="list(unknown)">Selected canonical items.</prop><prop name="label" type="string" default="">Accessible label.</prop><prop name="name" type="string" default="">Native submitted field name.</prop><prop name="placeholder" type="string" default="">Input placeholder.</prop><prop name="query" type="string?">Controlled query.</prop><prop name="readOnly" type="boolean" default="false">Read-only state.</prop><prop name="required" type="boolean" default="false">At least one item is required.</prop><prop name="tokenSeparators" type="list(string)">Keys that commit the current query.</prop>
    <state name="rows" :value="[]"></state><state name="raw" :value="''"></state><state name="loading" :value="false"></state><state name="lookupError" :value="''"></state><state name="canCreate" :value="false"></state>
    <event name="add-item" type="object({ item: unknown, index: number, trigger: keyboard | pointer | programmatic })"></event><event name="create-item" type="object({ query: string, trigger: keyboard | pointer | programmatic })"></event><event name="options-change" type="list(unknown)"></event><event name="query-change" type="object({ query: string, display: string, trigger: keyboard | pointer | programmatic })"></event><event name="remove-item" type="object({ item: unknown, index: number, trigger: keyboard | pointer | programmatic })"></event><method name="focusInput" export="focusInput" returns="promise(absent)"></method>
  </defs>
  <div class="multi-combobox" .config="config" .items="items" :data-default-query="defaultQuery" :data-disabled="disabled" :data-label="label" :data-placeholder="placeholder" :data-query="query" :data-read-only="readOnly" :data-required="required" :data-token-separators="tokenSeparators">
    <label $ref="label" class="multi-combobox__label"><span $value="label"></span></label><div $ref="field" class="multi-combobox__field"><div class="multi-combobox__items" role="group"><button class="multi-combobox__item" type="button" $each="item, i of items" $key="item.id" :data-index="i" :data-value="item.value"><slot :name="format('item-%s', item.id)"><span $value="item.label"></span></slot></button></div><input $ref="input" type="text" role="combobox" aria-autocomplete="list" autocomplete="off"><input type="hidden" $each="item of items" $key="item.id" :name="name" :value="item.value"></div>
    <div $ref="popup" class="multi-combobox__popup"><div role="listbox"><div class="multi-combobox__option" role="option" $each="row, i of rows" $key="row.id" :data-index="i" :aria-disabled="row.disabled"><slot :name="format('option-%s', row.id)"><span $value="row.label"></span></slot></div><div class="multi-combobox__option multi-combobox__create" role="option" $if="canCreate" :data-index="rows.length"><slot name="create"><span>Create “</span><span $value="raw"></span><span>”</span></slot></div></div><div $if="loading"><slot name="loading">Loading suggestions…</slot></div><div $if="lookupError"><slot name="error"><span $value="lookupError"></span></slot></div><div $if="not loading and not lookupError and rows.length = 0 and not canCreate"><slot name="empty">No suggestions.</slot></div><slot name="footer"></slot></div>
  </div>
</template>`,
  "ui-affordance-scope": `<template component="ui-affordance-scope" status="early" summary="A pointer-proximity coordination boundary." controller="./ui-affordance-scope.js">
  <defs><prop name="nearRadius" type="number" default="16">Distance outside an affordance that activates its near state.</prop></defs>
  <div class="affordance-scope" :data-near-radius="nearRadius"><slot></slot></div>
</template>`,
  "ui-dialog": `<template component="ui-dialog" status="early" summary="A native modal or non-modal dialog." controller="./ui-dialog.js">
  <defs>
    <prop name="open" type="boolean?">Controlled open state.</prop>
    <prop name="defaultOpen" type="boolean" default="false">Initial uncontrolled open state.</prop>
    <prop name="modal" type="boolean" default="true">Whether the dialog is modal.</prop>
    <prop name="dismissible" type="boolean" default="true">Whether Escape and light dismissal may close the dialog.</prop>
    <prop name="label" type="string?">Explicit accessible name.</prop>
    <event name="close" type="object({ open: boolean, reason: action | programmatic | light-dismiss | escape, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="dialog-host" :data-open="open" :data-default-open="defaultOpen" :data-modal="modal" :data-dismissible="dismissible" :data-label="label"><dialog $ref="dialog"><slot></slot></dialog></div>
</template>`,
  "ui-popover": `<template component="ui-popover" status="early" summary="A controlled or uncontrolled anchored popover." controller="./ui-popover.js">
  <defs>
    <prop name="open" type="boolean?">Controlled open state.</prop>
    <prop name="defaultOpen" type="boolean" default="false">Initial uncontrolled open state.</prop>
    <prop name="for" type="string?">Id of the anchor element.</prop>
    <prop name="placement" type="bottom-start | bottom-end | top-start | top-end" default="bottom-start">Preferred anchored placement.</prop>
    <event name="open" type="object({ open: boolean, reason: action | programmatic | light-dismiss | escape, trigger: keyboard | pointer | programmatic })"></event>
    <event name="close" type="object({ open: boolean, reason: action | programmatic | light-dismiss | escape, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="popover__surface" :data-open="open" :data-default-open="defaultOpen" :data-for="for" :data-placement="placement"><slot></slot></div>
</template>`,
  "ui-tooltip": `<template component="ui-tooltip" status="early" summary="An anchored description with pointer and keyboard intent." controller="./ui-tooltip.js">
  <defs>
    <prop name="for" type="string" default="">Id of the described element.</prop>
    <prop name="open" type="boolean?">Controlled open state.</prop>
    <prop name="defaultOpen" type="boolean" default="false">Initial uncontrolled open state.</prop>
    <prop name="placement" type="bottom-start | bottom-end | top-start | top-end" default="top-start">Preferred anchored placement.</prop>
    <prop name="showDelay" type="number" default="500">Pointer hover intent delay in milliseconds.</prop>
    <prop name="hideDelay" type="number" default="100">Pointer leave grace period in milliseconds.</prop>
    <prop name="toggleOnClick" type="boolean" default="false">Whether activation pins the tooltip.</prop>
    <event name="open" type="object({ open: boolean, reason: action | programmatic | light-dismiss | escape, trigger: keyboard | pointer | programmatic })"></event>
    <event name="close" type="object({ open: boolean, reason: action | programmatic | light-dismiss | escape, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="tooltip__surface" role="tooltip" :data-for="for" :data-open="open" :data-default-open="defaultOpen" :data-placement="placement" :data-show-delay="showDelay" :data-hide-delay="hideDelay" :data-toggle-on-click="toggleOnClick"><slot></slot></div>
</template>`,
  "ui-toast-region": `<template component="ui-toast-region" status="early" summary="A live notification region in the viewport layer." controller="./ui-toast-region.js">
  <defs>
    <prop name="open" type="boolean" default="true">Whether notifications may be shown.</prop>
    <event name="dismiss" type="object({ id: string, reason: action, trigger: keyboard | pointer | programmatic })"></event>
    <event name="close" type="object({ open: boolean, reason: action, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="toast-region" role="region" aria-label="Notifications" aria-live="polite" :data-enabled="open"><slot></slot></div>
</template>`,
  "ui-tree": `<template component="ui-tree" status="early" summary="An accessible, keyboard-navigable and reorderable tree." controller="./ui-tree.js">
  <defs>
    <prop name="hoverExpandDelay" type="number" default="700">Delay before a drag target expands.</prop>
    <prop name="label" type="string" default="Tree">Accessible tree label.</prop>
    <prop name="maxDepth" type="number" default="0">Maximum resulting item depth; zero is unlimited.</prop>
    <event name="reorder" type="object({ sourceId: string, targetId: string, position: before | inside | after, sourceType: string, targetType: string, sourceScope: string, targetScope: string, trigger: pointer })"></event>
    <event name="reorder-rejected" type="object({ sourceId: string, targetId: string, position: before | inside | after, reason: descendant | incompatible | max-depth, trigger: pointer })"></event>
  </defs>
  <div class="tree" role="tree" :aria-label="label" :data-hover-expand-delay="hoverExpandDelay" :data-max-depth="maxDepth"><slot></slot></div>
</template>`,
  "ui-tree-item": `<template component="ui-tree-item" status="early" summary="An accessible tree row with disclosure and drag metadata." controller="./ui-tree-item.js">
  <defs>
    <prop name="accepts" type="string" default="">Comma-separated drag kinds accepted as children.</prop>
    <prop name="container" type="boolean" default="false">Whether this item accepts and exposes children.</prop>
    <prop name="defaultExpanded" type="boolean" default="false">Initial uncontrolled expansion.</prop>
    <prop name="disabled" type="boolean" default="false">Disabled state.</prop>
    <prop name="dragType" type="string" default="item">Application-defined drag kind.</prop>
    <prop name="dropDepth" type="number?">Hierarchy depth override.</prop>
    <prop name="dropScope" type="string" default="">Application-defined parent/list identity.</prop>
    <prop name="expanded" type="boolean?">Controlled expansion state.</prop>
    <prop name="itemId" type="string" default="">Stable application identifier.</prop>
    <prop name="label" type="string" default="">Accessible item name.</prop>
    <prop name="selected" type="boolean" default="false">Selection state.</prop>
    <prop name="sortable" type="boolean" default="false">Whether pointer reordering is enabled.</prop>
    <prop name="subtreeDepth" type="number?">Virtualized descendant-depth override.</prop>
    <event name="expand" type="object({ id: string, expanded: boolean, trigger: keyboard | pointer | programmatic })"></event>
  </defs>
  <div class="tree-item" role="treeitem" :data-accepts="accepts" :data-container="container" :data-default-expanded="defaultExpanded" :data-disabled="disabled" :data-drag-type="dragType" :data-drop-depth="dropDepth" :data-drop-scope="dropScope" :data-expanded="expanded" :data-item-id="itemId" :data-label="label" :data-selected="selected" :data-sortable="sortable" :data-subtree-depth="subtreeDepth">
    <div $ref="row" class="tree-item__row"><button $ref="drag" class="tree-item__drag" type="button">Drag</button><button $ref="disclosure" class="tree-item__disclosure" type="button">Toggle</button><span class="tree-item__leading"><slot name="leading"></slot></span><span class="tree-item__label"><slot></slot></span><span class="tree-item__actions"><slot name="actions"></slot></span></div>
    <div $ref="children" class="tree-item__children" role="group"><slot name="children"></slot></div>
  </div>
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
    if (kind !== "select") {
      // The projected native control owns its current value when the wrapper is
      // uncontrolled. Updating defaultValue can also reset value on a pristine
      // input, so preserve the browser-owned value while syncing form-reset state.
      const currentValue = control.value;
      control.defaultValue = host.state.defaultValue || "";
      if (!controlled) control.value = currentValue;
    } else if (!initialized && host.state.defaultValue !== undefined) {
      control.value = host.state.defaultValue;
    }
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

const AVATAR_CONTROLLER = String.raw`function initials(value) {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "?";
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return (tokens[0][0] + tokens[1][0]).toUpperCase();
}

export default function controller(host) {
  const image = host.refs.image;
  const fallback = host.refs.fallback;
  let loaded = false;
  let source;
  const render = () => {
    const label = host.state.alt || host.state.name || "Avatar";
    host.element.setAttribute("aria-label", label);
    fallback.textContent = host.state.fallback || initials(host.state.name || host.state.alt);
    image.hidden = !loaded;
    image.setAttribute("aria-hidden", String(!loaded));
    fallback.hidden = loaded;
    fallback.setAttribute("aria-hidden", String(loaded));
    host.element.toggleAttribute("data-has-image", loaded);
  };
  const stop = host.effect(() => {
    if (source !== host.state.src) {
      source = host.state.src;
      loaded = false;
      image.src = source;
    }
    render();
  });
  const load = () => { loaded = true; render(); };
  const error = () => { loaded = false; render(); };
  image.addEventListener("load", load);
  image.addEventListener("error", error);
  return () => { stop(); image.removeEventListener("load", load); image.removeEventListener("error", error); };
}`;

const AVATAR_GROUP_CONTROLLER = String.raw`export default function controller(host) {
  let overflow;
  const apply = () => {
    const children = Array.from(host.element.children).filter((child) => child !== overflow);
    const limit = Math.max(0, Math.floor(host.state.max));
    children.forEach((child, index) => { child.hidden = index >= limit; });
    const count = Math.max(0, children.length - limit);
    if (count === 0) { overflow?.remove(); overflow = undefined; return; }
    overflow ||= host.element.ownerDocument.createElement("span");
    overflow.className = "overflow";
    overflow.setAttribute("role", "img");
    overflow.setAttribute("data-ui-avatar-group-overflow", "");
    overflow.setAttribute("aria-label", count + " more " + (count === 1 ? "person" : "people"));
    overflow.textContent = "+" + count;
    if (!overflow.isConnected) host.element.append(overflow);
  };
  const stop = host.effect(apply);
  const observer = new MutationObserver((records) => {
    if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => node !== overflow))) apply();
  });
  observer.observe(host.element, { childList: true });
  return () => { stop(); observer.disconnect(); overflow?.remove(); };
}`;

const DISCLOSURE_CONTROLLER = String.raw`${TRIGGER_OF}
let nextDisclosureId = 0;
export default function controller(host) {
  let trigger;
  let content;
  let initialized = false;
  let internal = false;
  const parts = () => {
    trigger = host.element.querySelector('[data-ui-disclosure-trigger], button, [aria-controls]');
    const controls = trigger?.getAttribute("aria-controls");
    content = controls ? host.element.ownerDocument.getElementById(controls) :
      Array.from(host.element.children).find((child) => child !== trigger);
    if (trigger && content && !content.id) content.id = "disclosure-content-" + (++nextDisclosureId);
    if (trigger && content) trigger.setAttribute("aria-controls", content.id);
  };
  const apply = () => {
    parts();
    const controlled = host.state.open !== undefined;
    if (!initialized) internal = controlled ? Boolean(host.state.open) : Boolean(host.state.defaultOpen);
    else if (controlled) internal = Boolean(host.state.open);
    if (trigger) {
      trigger.setAttribute("aria-expanded", String(internal));
      if (trigger instanceof HTMLButtonElement) trigger.disabled = Boolean(host.state.disabled);
      else trigger.setAttribute("aria-disabled", String(Boolean(host.state.disabled)));
    }
    if (content) content.hidden = !internal;
    initialized = true;
  };
  const stop = host.effect(apply);
  const toggle = (event) => {
    if (!trigger?.contains(event.target)) return;
    if (host.state.disabled) { event.preventDefault(); return; }
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    if (event.type === "keydown") event.preventDefault();
    const next = !internal;
    if (host.state.open === undefined) internal = next;
    apply();
    host.dispatch(next ? "open" : "close", { open: next, reason: "action", trigger: triggerOf(event) });
  };
  host.element.addEventListener("click", toggle);
  host.element.addEventListener("keydown", toggle);
  const observer = new MutationObserver(apply);
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); host.element.removeEventListener("click", toggle); host.element.removeEventListener("keydown", toggle); };
}`;

const TABS_CONTROLLER = String.raw`${TRIGGER_OF}
export default function controller(host) {
  let initialized = false;
  let internal = "";
  const tabs = () => Array.from(host.element.querySelectorAll('[role="tab"]'));
  const apply = () => {
    const items = tabs();
    const controlled = host.state.value !== undefined;
    if (!initialized) internal = controlled ? host.state.value : host.state.defaultValue;
    else if (controlled) internal = host.state.value;
    if (!internal && items.length > 0) internal = items[0].id || items[0].getAttribute("aria-controls") || "";
    items.forEach((tab) => {
      const value = tab.id || tab.getAttribute("aria-controls") || "";
      const selected = value === internal;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const controls = tab.getAttribute("aria-controls");
      const panel = controls && (host.element.querySelector("#" + CSS.escape(controls)) || host.element.ownerDocument.getElementById(controls));
      if (panel) panel.hidden = !selected;
    });
    host.element.setAttribute("aria-orientation", host.state.orientation);
    initialized = true;
  };
  const stop = host.effect(apply);
  const choose = (tab, trigger) => {
    const value = tab.id || tab.getAttribute("aria-controls") || "";
    if (!value) return;
    const previousValue = internal;
    if (host.state.value === undefined) internal = value;
    apply();
    host.dispatch("select", { value, ...(previousValue ? { previousValue } : {}), trigger });
  };
  const click = (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (tab && host.element.contains(tab)) choose(tab, triggerOf(event));
  };
  const keydown = (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab || !host.element.contains(tab)) return;
    const items = tabs();
    const vertical = host.state.orientation === "vertical";
    const previous = vertical ? event.key === "ArrowUp" : event.key === "ArrowLeft";
    const next = vertical ? event.key === "ArrowDown" : event.key === "ArrowRight";
    if (!previous && !next) return;
    event.preventDefault();
    const at = items.indexOf(tab);
    const index = previous ? (at - 1 + items.length) % items.length : (at + 1) % items.length;
    choose(items[index], "keyboard");
    items[index].focus();
  };
  host.element.addEventListener("click", click);
  host.element.addEventListener("keydown", keydown);
  const observer = new MutationObserver(apply);
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); host.element.removeEventListener("click", click); host.element.removeEventListener("keydown", keydown); };
}`;

const AFFORDANCE_CONTROLLER = String.raw`import { createProximityCoordinator } from "./overlay.js";
export default function controller(host) {
  let coordinator;
  const stop = host.effect(() => {
    coordinator?.destroy();
    coordinator = createProximityCoordinator(host.element, host.state.nearRadius);
  });
  const observer = new MutationObserver(() => coordinator?.refresh());
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); coordinator?.destroy(); };
}`;

const DIALOG_CONTROLLER = String.raw`import { createOverlay } from "./overlay.js";
export default function controller(host) {
  const dialog = host.refs.dialog;
  let initialized = false;
  let internal = false;
  let shown = false;
  let mode;
  let overlay;
  let closing = false;
  const label = () => {
    const heading = host.element.querySelector('[slot="heading"], [data-ui-dialog-title], h1, h2, h3, h4, h5, h6');
    return host.state.label?.trim() || heading?.textContent?.trim() || "Dialog";
  };
  const hide = () => {
    overlay?.destroy();
    overlay = undefined;
    if (dialog.open) {
      closing = true;
      dialog.close();
      closing = false;
    }
    shown = false;
  };
  const requestClose = (reason, trigger) => {
    if (!internal || !host.state.dismissible) return;
    if (typeof host.state.open !== "boolean") internal = false;
    if (!internal) hide();
    host.element.setAttribute("data-state", internal ? "open" : "closed");
    host.dispatch("close", { open: false, reason, trigger });
  };
  const apply = () => {
    const controlled = typeof host.state.open === "boolean";
    if (!initialized) internal = controlled ? host.state.open : Boolean(host.state.defaultOpen);
    else if (controlled) internal = host.state.open;
    dialog.setAttribute("aria-label", label());
    host.element.setAttribute("data-state", internal ? "open" : "closed");
    const nextMode = host.state.modal ? "modal" : "modeless";
    if (shown && mode !== nextMode) hide();
    if (internal && !shown) {
      mode = nextMode;
      if (host.state.modal) dialog.showModal(); else dialog.show();
      shown = true;
      overlay = createOverlay(host.element, {
        modal: host.state.modal,
        dismissible: host.state.dismissible,
        requestClose,
      });
      overlay.open();
    } else if (!internal && shown) hide();
    initialized = true;
  };
  const stop = host.effect(apply);
  const cancel = (event) => { event.preventDefault(); requestClose("escape", "keyboard"); };
  const nativeClose = () => {
    if (closing || !shown) return;
    shown = false;
    overlay?.destroy();
    overlay = undefined;
    if (typeof host.state.open !== "boolean") internal = false;
    host.dispatch("close", { open: false, reason: "programmatic", trigger: "programmatic" });
  };
  dialog.addEventListener("cancel", cancel);
  dialog.addEventListener("close", nativeClose);
  const observer = new MutationObserver(() => dialog.setAttribute("aria-label", label()));
  observer.observe(host.element, { childList: true, subtree: true, characterData: true });
  return () => { stop(); observer.disconnect(); dialog.removeEventListener("cancel", cancel); dialog.removeEventListener("close", nativeClose); hide(); };
}`;

const POPOVER_CONTROLLER = String.raw`import { createAnchoredSurface, createOverlay } from "./overlay.js";
export default function controller(host) {
  let initialized = false;
  let internal = false;
  let anchor;
  let placement;
  let surface;
  let overlay;
  const hide = () => { overlay?.destroy(); overlay = undefined; surface?.hide(); };
  const requestClose = (reason, trigger) => {
    if (!internal) return;
    if (typeof host.state.open !== "boolean") internal = false;
    if (!internal) hide();
    host.element.setAttribute("data-state", internal ? "open" : "closed");
    host.dispatch("close", { open: false, reason, trigger });
  };
  const apply = () => {
    const controlled = typeof host.state.open === "boolean";
    if (!initialized) internal = controlled ? host.state.open : Boolean(host.state.defaultOpen);
    else if (controlled) internal = host.state.open;
    const nextAnchor = host.state.for ? host.element.ownerDocument.getElementById(host.state.for) : null;
    if (!surface || anchor !== nextAnchor || placement !== host.state.placement) {
      surface?.destroy();
      anchor = nextAnchor;
      placement = host.state.placement;
      surface = createAnchoredSurface(host.element, anchor, placement);
    }
    host.element.setAttribute("data-state", internal ? "open" : "closed");
    if (internal) {
      surface.show();
      if (!overlay) {
        overlay = createOverlay(host.element, { relatedElements: anchor ? [anchor] : [], requestClose });
        overlay.open();
      }
    } else hide();
    initialized = true;
  };
  const stop = host.effect(apply);
  return () => { stop(); hide(); surface?.destroy(); };
}`;

const CONTROLLERS: Readonly<Record<string, string>> = Object.freeze({
  "ui-input": FORM_VALUE_CONTROLLER,
  "ui-textarea": FORM_VALUE_CONTROLLER,
  "ui-select": FORM_VALUE_CONTROLLER,
  "ui-checkbox": TOGGLE_CONTROLLER,
  "ui-radio": TOGGLE_CONTROLLER,
  "ui-radio-group": RADIO_GROUP_CONTROLLER,
  "ui-switch": SWITCH_CONTROLLER,
  "ui-avatar": AVATAR_CONTROLLER,
  "ui-avatar-group": AVATAR_GROUP_CONTROLLER,
  "ui-disclosure": DISCLOSURE_CONTROLLER,
  "ui-tabs": TABS_CONTROLLER,
  "ui-affordance-scope": AFFORDANCE_CONTROLLER,
  "ui-dialog": DIALOG_CONTROLLER,
  "ui-popover": POPOVER_CONTROLLER,
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
