export const controllerRefsSource = `<template component="x-refs" status="early" summary="Controller ref ownership." controller="./refs.js"><defs>
  <state name="rows" type="list(number)" value="[1]"></state>
  <state name="later" type="list(number)" value="[]"></state>
  <state name="visible" type="boolean" value="true"></state>
  <handler name="validate"><validate ref="field"></validate></handler>
  <handler name="focus"><focus ref="row"></focus></handler>
</defs><section>
  <button type="button" $if="visible" $ref="single">Single</button>
  <input $if="visible" $ref="field" required aria-label="Field">
  <button type="button" data-action="validate" on:click="validate">Validate</button>
  <button type="button" data-action="focus" on:click="focus">Focus row</button>
  <ul><li tabindex="-1" $each="row of rows" $key="row" $ref="row" $value="row"></li></ul>
  <ol><li $each="row of later" $key="row" $ref="later" $value="row"></li></ol>
</section><style>:host { display: block; min-height: 24px; font: 16px/24px Arial, sans-serif; } ul, ol { margin: 0; } li:focus { outline: none; }</style></template>`;

export const controllerRefsModule = `export default function connect(host) {
  window.refsHost = host;
  window.refsEffects = 0;
  window.refsInvalid = 0;
  const stop = host.effect(() => { void host.refs.row; window.refsEffects++; });
  return stop;
}`;
