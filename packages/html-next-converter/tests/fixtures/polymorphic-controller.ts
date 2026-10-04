export const polymorphicControllerSource = `<template component="x-switch" status="early" summary="Polymorphic root." controller="./switch.js"><defs>
  <state type="boolean" name="linked" value="false"></state>
  <handler name="switch"><set name="linked" expr:value="linked = false"></set></handler>
</defs><template $match><a $when="linked" $ref="link" href="#next" on:click.prevent="switch">Link</a>
  <button $else $ref="button" type="button" on:click="switch">Button</button></template>
<style>:host { display: inline-block; padding: 4px; color: rgb(20 70 130); font: 16px/24px Arial, sans-serif; }</style></template>`;
export const polymorphicControllerModule = `export default function connect(host) {
  const root = host.root;
  window.switchHost = host;
  window.switchTrace.push(["connect", root.localName]);
  const stop = host.effect(() => {
    const current = host.root;
    current.setAttribute("data-controller-root", current.localName);
    window.switchEffects.push(current.localName);
  });
  return () => { stop(); window.switchTrace.push(["disconnect", root.localName]); };
}`;
