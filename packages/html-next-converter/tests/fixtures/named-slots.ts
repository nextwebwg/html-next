/**
 * A link form invoking a search result row through its named slots, as Looma's link and image
 * toolbars do: elements with `slot`, `<template slot>`, conditional and repeated slot content,
 * several elements for one slot, a `<template slot>` beside elements for the same slot, which it
 * replaces, a scoped slot and default content.
 */
export const rowSource = `<template component="ui-search-result-row" status="early" summary="A result row with named slots."><defs>
  <prop name="value" type="string" default="">The row's value.</prop>
</defs><div class="row"><span class="prefix"><slot name="prefix"></slot></span>
  <span class="leading"><slot name="leading"></slot></span>
  <span class="label"><slot name="label"></slot></span>
  <strong class="title"><slot name="title"><em>Untitled</em></slot></strong>
  <span class="meta"><slot name="meta">No meta</slot></span>
  <span class="body"><slot></slot></span>
  <span class="trailing"><slot name="trailing"></slot></span>
  <span class="action"><slot name="action" from:value="$value"></slot></span></div></template>`;

export const linkFormSource = `<link rel="component" href="./row.html">
<template component="ui-editor-link-form" status="early" summary="A link form."><defs>
  <state name="href" type="string" value="https://example.org"></state>
  <state name="open" type="boolean" value="false"></state>
  <state name="tags" type="list(string)" value="['docs']"></state>
  <handler name="toggle"><set name="open" expr:value="not $open"></set><set name="tags" expr:value="['docs', 'guide']"></set></handler>
</defs><form><button type="button" class="toggle" on:click="toggle">Toggle</button>
  <ui-search-result-row id="case" from:value="$href">
    <i slot="prefix" class="icon">&gt;</i>
    <span slot="leading">Link</span>
    <span slot="label" $value="$href"></span>
    <span slot="title">Example</span>
    <span slot="meta" $if="$open">Opened</span>
    <span slot="leading" $each="tag of $tags">#{$tag}</span>
    <span slot="trailing">Replaced</span>
    <template slot="trailing"><b>!</b></template>
    <template slot="action"><button type="button" class="act" $value="$value"></button></template>
    <p>Body text</p>
  </ui-search-result-row></form></template>`;

/** Each slot's text in the row, before `toggle`, after it, and after it again. */
export const namedSlotText = {
  initial: { prefix: ">", leading: "Link#docs", label: "https://example.org", title: "Example", meta: "No meta", body: "Body text", trailing: "!", action: "https://example.org" },
  toggled: { prefix: ">", leading: "Link#docs#guide", label: "https://example.org", title: "Example", meta: "Opened", body: "Body text", trailing: "!", action: "https://example.org" },
  closed: { prefix: ">", leading: "Link#docs#guide", label: "https://example.org", title: "Example", meta: "No meta", body: "Body text", trailing: "!", action: "https://example.org" },
} as const;
