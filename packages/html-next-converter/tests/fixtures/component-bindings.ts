export const componentBindingsSource = `<template component="x-state-field" status="early" summary="State-selected bound field." controller="./selected.js"><defs>
  <state name="mode" type="keyword" values="number, text" value="number"></state>
  <prop name="value">Value.<type from="mode"><option value="number" type="number"></option><option value="text" type="string"></option></type></prop>
</defs><input value="99" from:type="mode = 'number' ? 'number' : 'text'" from:data-mode="mode" .value="value"></template>
<template component="x-prop-field" status="early" summary="Prop-selected bound field." controller="./selected.js"><defs>
  <prop name="mode" type="keyword" values="number, text" default="number">Mode.</prop>
  <prop name="value">Value.<type from="mode"><option value="number" type="number"></option><option value="text" type="string"></option></type></prop>
</defs><input value="99" from:type="mode = 'number' ? 'number' : 'text'" .value="value"></template>
<template component="x-number-field" status="early" summary="Typed number field."><defs>
  <prop name="amount" type="number" default="4">Amount.</prop>
</defs><input type="number" value="99" .value="amount"></template>
<template component="x-text-field" status="early" summary="Typed text field."><defs>
  <prop name="value" type="string" default="fallback">Text.</prop>
</defs><input value="authored text" .value="value"></template>
<template component="x-flag-field" status="early" summary="Typed checkbox."><defs>
  <prop name="checked" type="boolean" default="false">Flag.</prop>
</defs><input type="checkbox" .checked="checked"></template>
<template component="x-native-switch" status="early" summary="Changing native binding root."><defs><prop name="mode" type="keyword" values="field, area, generic" default="field">Root.</prop></defs><template $match><input $when="mode = 'field'" value="Field default"><textarea $when="mode = 'area'">Area default</textarea><output $else value="Generic attribute">Generic default</output></template></template>
<template component="x-native-delegate" status="early" summary="Delegated native binding."><defs><prop name="mode" type="keyword" values="field, area, generic" default="field">Root.</prop></defs><x-native-switch from:mode="mode"></x-native-switch></template>
<template component="x-owned-input" status="early" summary="Locally controlled bound root." controller="./owned.js"><defs><state name="local" type="string" value="Own"></state></defs><input value="Own default" .value="local" from:data-local="local"></template>
<template component="x-untyped-number" status="early" summary="Undeclared number binding."><input type="number" value="99"></template>
<template component="x-untyped-text" status="early" summary="Undeclared array binding."><input value="default"></template>
<template component="x-untyped-flag" status="early" summary="Undeclared checked binding."><input type="checkbox"></template>
<template component="x-untyped-radio" status="early" summary="Undeclared radio binding."><input type="radio" name="bound-radio"></template>
<template component="x-untyped-file" status="early" summary="Undeclared file binding."><input type="file"></template>
<template component="x-untyped-area" status="early" summary="Undeclared textarea binding."><textarea>Textarea default</textarea></template>
<template component="x-untyped-select" status="early" summary="Undeclared select binding." controller="./options.js"><defs><state name="optionValue" type="keyword" values="b, bb" value="b"></state><state name="hasC" type="boolean" value="true"></state></defs><select><option value="a" selected>A</option><option from:value="optionValue">B</option><option value="c" $if="hasC">C</option></select></template>
<template component="x-untyped-multiple" status="early" summary="Undeclared multiple binding." controller="./options.js"><defs><state name="optionValue" type="keyword" values="b, bb" value="b"></state><state name="hasC" type="boolean" value="true"></state></defs><select multiple><option value="a" selected>A</option><option from:value="optionValue">B</option><option value="c" $if="hasC">C</option></select></template>
<template component="x-untyped-output" status="early" summary="Undeclared generic binding."><output value="authored">Generic</output></template>
<template component="x-bound-fields" status="early" summary="Nested component bindings." controller="./fields.js"><defs>
  <state name="selected" type="object({ value: unknown })" value="{ value: 12 }"></state>
  <state name="mode" type="keyword" values="number, text" value="number"></state>
  <state name="rootMode" type="keyword" values="field, area, generic" value="field"></state>
  <state name="rawChecked" type="object({ value: unknown })" value="{ value: [] }"></state>
  <state name="radios" type="object({ first: boolean, second: boolean })" value="{ first: true, second: false }"></state>
  <state name="file" type="string" value=""></state>
  <state name="choice" type="string" value="b"></state>
  <state name="choices" type="list(string)" value="['a', 'b']"></state>
  <state name="empty" type="number"></state>
  <state name="form" type="object({ amount: number, text: string, checked: boolean })" value="{ amount: 12, text: 'Ready', checked: true }"></state>
</defs><form>
  <x-number-field id="number" bind:amount="form.amount"></x-number-field>
  <x-text-field id="text" bind:value="form.text"></x-text-field>
  <x-number-field id="empty" amount="7" bind:amount="empty"></x-number-field>
  <x-flag-field id="flag" bind:checked="form.checked"></x-flag-field>
  <x-native-switch id="native-switch" from:mode="rootMode" bind:value="form.text"></x-native-switch>
  <x-native-delegate id="delegated-switch" from:mode="rootMode" bind:value="form.text"></x-native-delegate>
  <x-owned-input id="owned-input" bind:value="form.text"></x-owned-input>
  <x-untyped-number id="untyped-number" bind:value="form.amount"></x-untyped-number>
  <x-untyped-number id="untyped-unbound" from:value="'2'"></x-untyped-number>
  <x-untyped-text id="untyped-array" bind:value="choices"></x-untyped-text>
  <x-untyped-flag id="untyped-flag" bind:checked="form.checked"></x-untyped-flag>
  <input id="raw-property-flag" type="checkbox" .checked="rawChecked.value">
  <x-untyped-flag id="untyped-raw-flag" bind:checked="rawChecked.value"></x-untyped-flag>
  <x-untyped-radio id="radio-first" bind:checked="radios.first"></x-untyped-radio>
  <x-untyped-radio id="radio-second" bind:checked="radios.second"></x-untyped-radio>
  <x-untyped-file id="untyped-file" bind:value="file"></x-untyped-file>
  <x-untyped-area id="untyped-area" bind:value="form.text"></x-untyped-area>
  <x-untyped-select id="untyped-select" bind:value="choice"></x-untyped-select>
  <x-untyped-multiple id="untyped-multiple" bind:value="choices"></x-untyped-multiple>
  <x-untyped-output id="unbound-output" from:value="form.text"></x-untyped-output>
  <x-untyped-output id="prototype-output" bind:__proto__="form.text" bind:constructor="form.text"></x-untyped-output>
  <x-untyped-output id="untyped-output" bind:value="form.text"></x-untyped-output>
  <x-state-field id="state-selected" bind:value="selected.value"></x-state-field>
  <x-prop-field id="prop-selected" from:mode="mode" bind:value="selected.value"></x-prop-field>
  <output id="amount" $value="form.amount"></output><output id="label" $value="form.text"></output><output id="checked" $value="form.checked"></output>
</form><style>:host { display: block; font: 16px/24px Arial, sans-serif; } input { width: 80px; }</style></template>`;

export const componentBindingsModule = `export default function connect(host) { window.fieldsHost = host; }`;

export const selectedBindingModule = `export default function connect(host) { window.selectedHosts ??= {}; window.selectedHosts[host.root.id] = host; }`;

export const componentOptionsModule = `export default function connect(host) { window.optionHosts ??= {}; window.optionHosts[host.root.id] = host; }`;

export const componentOwnedModule = `export default function connect(host) { window.ownedHost = host; }`;
