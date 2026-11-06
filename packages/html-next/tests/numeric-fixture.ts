import { parseComponent } from "../src/source-parser.js";

export const numericDefinition = parseComponent(`<template component="ssr-finite-results"><defs>
  <state name="denominator" type="number" value="0"></state><state name="value" type="number" value="99"></state>
  <computed name="result" from="1 / $denominator"></computed>
  <handler name="valid"><set name="denominator" value="2"></set></handler>
  <handler name="invalid"><set name="denominator" value="0"></set></handler>
  <handler name="recover"><set name="denominator" value="4"></set></handler>
  </defs><section><button id="valid" on:click="valid">Valid</button><button id="invalid" on:click="invalid">Invalid</button>
  <button id="recover" on:click="recover">Recover</button><b id="computed">{$result}</b><i id="direct">{1 / $denominator}</i>
  <u id="attribute" data-value="authored" from:data-value="1 / $denominator"></u>
  <ssr-finite-child id="child" from:value="1 / $denominator"></ssr-finite-child><ssr-finite-slot from:denominator="$denominator"><template slot="body"><b id="scoped">{$value}</b><i id="scoped-missing">{$absent = null}</i></template></ssr-finite-slot></section></template>`);

export const numericDefinitions = [numericDefinition, parseComponent(`<template component="ssr-finite-child"><defs>
  <prop name="value" type="number" default="5">Number.</prop></defs><output>{$value}</output></template>`), parseComponent(`<template component="ssr-finite-slot"><defs>
  <prop name="denominator" type="number" default="0">Denominator.</prop><state name="record" type="object({ ... })" value="{}"></state>
  <slot name="body"><prop name="value" type="number" default="5">Value.</prop><prop name="absent" type="unknown" required>Missing.</prop></slot>
  </defs><div><slot name="body" from:value="1 / $denominator" from:absent="$record.missing"></slot></div></template>`)];
