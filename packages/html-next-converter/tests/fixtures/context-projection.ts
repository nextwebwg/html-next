export const contextProviderSource = `<template component="x-steps" status="early" summary="Steps."><defs>
  <state type="number" name="current" value="1"></state>
  <handler name="next"><set name="current" expr:value="$current + 1"></set></handler>
</defs><section><button type="button" on:click="next">Next</button><slot></slot></section>
<style>:host { display: block; border: 2px solid rgb(31 65 99); padding: 4px; }</style></template>`;
export const contextReaderSource = `<template component="x-step" status="early" summary="Step."><defs>
  <prop name="number" type="number" required>Step number.</prop>
  <context name="current" from="x-steps" as="activeStep"></context>
  <computed name="isActive" from="$activeStep = $number"></computed>
</defs><p from:data-active="$isActive ? 'yes' : 'no'"><slot></slot></p>
<style>:host[data-active="yes"] { color: rgb(20 110 60); }</style></template>`;
export const contextAppSource = `<template component="x-app" status="early" summary="App."><main>
  <x-steps id="outer"><x-step id="outer-one" number="1">Outer one</x-step><x-step id="outer-two" number="2">Outer two</x-step>
    <x-steps id="inner"><x-step id="inner-one" number="1">Inner one</x-step><x-step id="inner-two" number="2">Inner two</x-step></x-steps>
  </x-steps>
</main></template>`;
