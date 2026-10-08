export const delegatedDecorationsSource = `<template component="x-styled-leaf" status="early" summary="Leaf decorations." controller="./leaf.js"><defs>
  <state name="linked" type="boolean" value="false"></state>
  <state name="active" type="boolean" value="true"></state>
  <state name="color" type="string" value="green"></state>
  <handler name="change"><set name="color" value="brown"></set><set name="active" value="false"></set><set name="linked" expr:value="$linked = false"></set></handler>
</defs><template $match><button $when="$linked = false" data-leaf class="base active" style="color: blue !important" class:active="$active" style:color="$color" on:click.prevent="change" type="button">Decorated</button><a $else data-leaf class="base active" style="color: blue !important" class:active="$active" style:color="$color" on:click.prevent="change" href="#next">Decorated</a></template></template>
<template component="x-styled-adapter" status="early" summary="Native delegated adapter."><defs></defs><x-styled-leaf></x-styled-leaf></template>
<template component="x-styled-middle" status="early" summary="Delegated decorations." controller="./middle.js"><defs>
  <state name="active" type="boolean" value="true"></state>
  <state name="color" type="string" value="purple"></state>
</defs><x-styled-adapter class="middle active" style="background-color: white" class:active="$active" style:color="$color"></x-styled-adapter></template>
<template component="x-styled-parent" status="early" summary="Outer decorations." controller="./parent.js"><defs>
  <state name="active" type="boolean" value="false"></state>
  <state name="color" type="string" value="red"></state>
</defs><section><x-styled-middle $ref="shared" class="consumer" class:active="$active" style:color="$color"></x-styled-middle></section>
<style>:host { display: block; width: 220px; padding: 4px; font: 16px/24px Arial, sans-serif; } button { font: inherit; }</style></template>`;
