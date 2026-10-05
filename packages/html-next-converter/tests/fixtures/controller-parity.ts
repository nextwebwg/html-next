export const controllerParitySource = `<template component="x-controlled" status="early" summary="Controller parity." controller="./controlled.js"><defs>
  <prop name="amount" type="number" default="5">Controller prop.</prop>
  <state name="receivers" type="list(number)" value="[1,2]"></state>
  <handler name="sendOne"><dispatch target="button" event="saved" expr:value="{ reason: 'action' }"></dispatch></handler>
  <handler name="sendAll"><dispatch target="receivers" event="saved" expr:value="{ reason: 'action' }"></dispatch></handler>
  <state type="number" name="count" value="0"></state>
  <state type="object({ value: number })" name="nested" value="{ value: 1 }"></state>
  <handler name="sameNested"><set name="nested.value" value="1"></set></handler>
  <event name="saved" type="object" bubbles="false" composed="false" cancelable="true"><prop name="reason" type="keyword" values="action, programmatic" required></prop></event>
  <event name="contact" type="email"></event>
  <event name="quantity" type="number"></event>
  <event name="incremented" type="number"></event>
  <event name="labels" type="keyword+"></event>
</defs><section on:request-one="sendOne" on:request-all="sendAll"><button type="button" $ref="button">Increment</button><button class="same-nested" type="button" on:click="sameNested">Same</button><output $value="count"></output><x-dispatch-receiver $each="receiver of receivers" $key="receiver" $ref="receivers" from:receiver="receiver"></x-dispatch-receiver></section>
<style>:host { display: block; width: 180px; padding: 4px; background: rgb(240 245 250); font: 16px/24px Arial, sans-serif; }</style></template>
<template component="x-dispatch-receiver" status="early" summary="Receives targeted events."><defs><prop name="receiver" type="number" default="0">Receiver number.</prop><state name="hits" type="number" value="0"></state><handler name="receive"><set name="hits" expr:value="hits + 1"></set></handler></defs><span hidden on:saved="receive" from:data-receiver="receiver" from:data-hits="hits"></span></template>`;
export const controllerParityModule = `function connect(host) {
  window.trace.connects++;
  window.controllerHost = host;
  const local = host.signal(1);
  const doubled = host.computed(() => local.get() * 2);
  const stopDisplay = host.effect(() => {
    window.trace.effects++;
    host.root.setAttribute("data-local", String(doubled.get()));
    return () => { window.trace.effectCleanups++; };
  });
  const stopProp = host.effect(() => {
    host.root.setAttribute("data-amount-value", String(host.props.amount.value));
    host.root.setAttribute("data-amount-input", String(host.props.amount.inputValue));
    host.root.setAttribute("data-amount-valid", String(host.props.amount.validate().valid));
    host.root.setAttribute("data-state-has-amount", String("amount" in host.state));
  });
  const stopNested = host.effect(() => {
    window.trace.nestedEffects++;
    host.root.setAttribute("data-nested", String(host.state.nested.value));
  });
  const stopClick = host.effect(() => {
    const button = host.refs.button;
    const click = () => { local.update((value) => value + 1); host.state.count += 1; };
    button.addEventListener("click", click);
    return () => button.removeEventListener("click", click);
  });
  const cleanup = () => { window.cleanupRoot = host.root.localName; stopDisplay(); stopProp(); stopNested(); stopClick(); window.trace.disconnects++; };
  if (window.delayController) return new Promise((resolve) => { window.releaseController = () => resolve(cleanup); });
  return cleanup;
}
export default function initialize(host) {
  host.on("request-increment", () => { host.state.count += 1; host.dispatch("incremented", host.state.count); });
  if (window.delayController) return connect(host);
  host.on("connect", () => connect(host));
}`;
