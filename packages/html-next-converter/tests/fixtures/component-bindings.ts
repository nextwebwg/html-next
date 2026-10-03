export const componentBindingsSource = `<template component="x-number-field" status="early" summary="Typed number field."><defs>
  <prop name="amount" type="number" default="4">Amount.</prop>
</defs><input type="number" value="99" .value="amount"></template>
<template component="x-text-field" status="early" summary="Typed text field."><defs>
  <prop name="value" type="string" default="fallback">Text.</prop>
</defs><input value="authored text" .value="value"></template>
<template component="x-flag-field" status="early" summary="Typed checkbox."><defs>
  <prop name="checked" type="boolean" default="false">Flag.</prop>
</defs><input type="checkbox" .checked="checked"></template>
<template component="x-bound-fields" status="early" summary="Nested component bindings." controller="./fields.js"><defs>
  <state name="form" type="object({ amount: number, text: string, checked: boolean })" value="{ amount: 12, text: 'Ready', checked: true }"></state>
</defs><form>
  <x-number-field id="number" bind:amount="form.amount"></x-number-field>
  <x-text-field id="text" bind:value="form.text"></x-text-field>
  <x-flag-field id="flag" bind:checked="form.checked"></x-flag-field>
  <output id="amount" $value="form.amount"></output><output id="label" $value="form.text"></output><output id="checked" $value="form.checked"></output>
</form><style>:host { display: block; font: 16px/24px Arial, sans-serif; } input { width: 80px; }</style></template>`;

export const componentBindingsModule = `export default function connect(host) { window.fieldsHost = host; }`;
