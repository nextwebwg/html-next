export const delegatedDecorationsSource = `<template component="x-styled-leaf" status="early" summary="Leaf decorations." controller="./leaf.js"><defs>
  <state name="active" type="boolean" value="true"></state>
  <state name="color" type="string" value="green"></state>
  <method name="inner" returns="promise(undefined)"></method>
  <handler name="change"><set name="color" value="brown"></set><set name="active" value="false"></set></handler>
</defs><button class="base active" style="color: blue !important" class:active="active" style:color="color" on:click="change" type="button">Decorated</button></template>
<template component="x-styled-middle" status="early" summary="Delegated decorations." controller="./middle.js"><defs>
  <method name="outer" returns="promise(string)"></method>
  <state name="active" type="boolean" value="true"></state>
  <state name="color" type="string" value="purple"></state>
</defs><x-styled-leaf class="middle active" style="background-color: white" class:active="active" style:color="color"></x-styled-leaf></template>
<template component="x-styled-parent" status="early" summary="Outer decorations." controller="./parent.js"><defs>
  <state name="active" type="boolean" value="false"></state>
  <state name="color" type="string" value="red"></state>
</defs><section><x-styled-middle class="consumer" class:active="active" style:color="color"></x-styled-middle></section>
<style>:host { display: block; width: 220px; padding: 4px; font: 16px/24px Arial, sans-serif; } button { font: inherit; }</style></template>`;
