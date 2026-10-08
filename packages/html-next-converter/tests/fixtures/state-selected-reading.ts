export const stateSelectedReading = `<template component="x-state-reading" status="early" summary="State-selected reading."><defs>
  <state name="mode" type="keyword" values="number, text" value="number"></state>
  <prop name="value">Value.<type from="mode"><option value="number" type="number"></option><option value="text" type="string"></option></type></prop>
  <handler name="switch"><set name="mode" expr:value="$mode = 'number' ? 'text' : 'number'"></set></handler>
</defs><button on:click="switch" from:data-mode="$mode"><span from:data-value="$value" from:title="$value = 2 ? 'two' : 'other'"><template $value="$value"></template></span></button></template>`;
