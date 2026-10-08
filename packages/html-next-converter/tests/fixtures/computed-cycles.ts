export const computedCycles = {
  self: '<template component="x-self-cycle" status="early" summary="Self cycle."><defs><computed name="loop" from="$loop + 1"></computed></defs><div from:data-value="$loop"></div></template>',
  mutual: '<template component="x-mutual-cycle" status="early" summary="Mutual cycle."><defs><computed name="left" from="$right + 1"></computed><computed name="right" from="$left + 1"></computed></defs><div from:data-value="$left"></div></template>',
} as const;
