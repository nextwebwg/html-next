export const recursiveDepthSource = `<template component="x-depth" status="early" summary="Bounded recursive component."><defs>
  <prop name="level" type="number" default="0">Current depth.</prop>
</defs><section><span $value="$level"></span><x-depth $if="$level < 33" from:level="$level + 1"></x-depth></section></template>`;
