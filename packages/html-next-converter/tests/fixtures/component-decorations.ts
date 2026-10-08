export const componentDecorationsSource = `<template component="x-empty-class" status="early" summary="Empty native class."><i class="">Empty root</i></template>
<template component="x-styled-leaf" status="early" summary="Leaf decorations." controller="./leaf.js"><defs>
  <state name="active" type="boolean" value="true"></state>
  <state name="color" type="string" value="green"></state>
  <state name="padding" type="string" value="6px"></state>
</defs><button class="base active" style="color: blue !important; padding: 2px !important" class:active="$active" style:color="$color" style:padding-left="$padding" type="button">Decorated</button></template>
<template component="x-styled-middle" status="early" summary="Delegated decorations." controller="./middle.js"><defs>
  <state name="active" type="boolean" value="true"></state>
  <state name="color" type="string" value="purple"></state>
</defs><article class="middle active" style="border: 1px solid black; color: navy !important" class:active="$active" style:color="$color"><x-styled-leaf class="nested" style="background-color: white; padding: 3px !important" class:active="$active" style:color="$color"></x-styled-leaf></article></template>
<template component="x-styled-parent" status="early" summary="Independent owner decorations." controller="./parent.js"><defs>
  <state name="active" type="boolean" value="false"></state>
  <state name="color" type="string" value="red"></state>
  <state name="padding" type="string" value="10px"></state>
</defs><section><x-styled-middle class="consumer" style="background-color: rgb(240, 240, 240); width: 200px; width:; --blank:; padding: 4px !important" class:active="$active" style:color="$color" style:padding-left="$padding"></x-styled-middle><i class:ghost="false" style:color="'not-a-color'">Marker</i>
<i class="" class:ghost="false">Empty literal</i><i class="active" class:active="false">Cleared token</i><x-empty-class></x-empty-class>
<svg width="0" height="0"><g class="" class:ghost="false"></g><g class="active" class:active="false"></g><g class:ghost="false"></g></svg></section>
<style>:host { display: block; width: 220px; padding: 4px; font: 16px/24px Arial, sans-serif; } button { font: inherit; } i[class], i[style] { font-style: normal; background: pink; }</style></template>`;

export function componentDecorationsController(owner: string): string {
  return `export default function initialize(host) { host.on("connect", () => { window.styleHosts ??= {}; window.styleHosts[${JSON.stringify(owner)}] = host; }); }`;
}
