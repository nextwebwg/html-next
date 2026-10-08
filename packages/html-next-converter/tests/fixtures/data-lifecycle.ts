export const dataLifecycleSource = `<template component="x-data-cycle" status="early" summary="Data lifecycle."><defs>
  <state type="number" name="page" value="1"></state>
  <computed name="requestPage" from="$page + 1"></computed>
  <data name="feed" src="./api/feed" type="object({ label: string })" debounce="20ms" poll="1500ms">
    <param name="page" from:value="$requestPage"></param>
  </data>
  <handler name="next"><set name="page" expr:value="$page + 1"></set></handler>
</defs><section><button type="button" on:click="next">Next</button>
  <output class="label" $value="$feed.value.label"></output>
  <output class="pending" $value="$feed.pending"></output>
  <output class="ok" $value="$feed.ok"></output>
  <output class="failed" $value="$feed.error ? 'yes' : 'no'"></output>
</section><style>:host { display: block; background: rgb(238 244 250); padding: 4px; }</style></template>`;
