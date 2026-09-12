import {
  scaffoldStencilComponent,
  type StencilComponentInventory,
  type StencilScaffoldDiagnostic,
} from "./stencil.js";

export interface LoomaMigration {
  readonly source: string;
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
});

export function migrateLoomaComponent(component: StencilComponentInventory): LoomaMigration {
  const port = PORTS[component.tag];
  if (port !== undefined) return Object.freeze({ source: `${port}\n`, status: "ported", diagnostics: Object.freeze([]) });
  const scaffold = scaffoldStencilComponent(component);
  return Object.freeze({ source: scaffold.source, status: "scaffold", diagnostics: scaffold.diagnostics });
}

export const LOOMA_PORTED_TAGS = Object.freeze(Object.keys(PORTS).sort());
