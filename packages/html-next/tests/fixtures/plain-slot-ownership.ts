import { readFileSync } from "node:fs";

const native = JSON.parse(readFileSync(new URL("../../../html-next-dotnet/tests/fixtures/accepted-child-lists.json", import.meta.url), "utf8")) as readonly {
  name: string; source: string; expected: string;
}[];
const cases = native.filter(fixture => fixture.name.startsWith("plain-child-slot-shared-with-own-outlet-") || fixture.name === "plain-child-slot-repeated-own-outlets");
export const plainSlotFiles: Readonly<Record<string, string>> = Object.fromEntries(cases.map((fixture, index) => [
  `plain-${index}.html`, fixture.source.replaceAll("x-column", `x-plain-${index}-column`).replaceAll("x-list", `x-plain-${index}-list`).replaceAll("x-page", `x-plain-${index}-page`)
    .replace("<main>", `<article data-plain-case="${index}">`).replace("</main>", "</article>"),
]));
export const plainSlotInvocations = cases.map((_, index) => `<x-plain-${index}-page></x-plain-${index}-page>`).join("");
export const plainSlotExpected = [
  [["b", "Plain"], ["p", "BorrowedFallback"]],
  [["p", "Plain"], ["b", "OwnFallback"]],
  [["p", "Plain"]],
  [["b", "PlainSecondFallback"], ["p", "BorrowedFallback"]],
];
export const dynamicPlainSource = `<template component="x-moving-column"><defs><slot name="cell"></slot></defs><b><slot name="cell">OwnFallback</slot></b></template>
<template component="x-moving-list"><defs><slot accepts="x-moving-column" as="columns"></slot>
<state name="root" type="boolean" value="true"></state><state name="borrowed" type="boolean" value="true"></state>
<handler name="toggle-root"><set name="root" expr:value="not $root"></set></handler><handler name="toggle-borrowed"><set name="borrowed" expr:value="not $borrowed"></set></handler>
</defs><section data-moving-plain><button data-plain-action="root" on:click="toggle-root">Root</button><button data-plain-action="borrowed" on:click="toggle-borrowed">Borrowed</button>
<template $if="$borrowed"><p $each="column of $columns"><slot of="$column" name="cell">BorrowedFallback</slot></p></template><slot $if="$root"></slot></section></template>
<template component="x-moving-page"><defs><state name="show" type="boolean" value="true"></state><handler name="toggle-content"><set name="show" expr:value="not $show"></set></handler></defs><article><button data-plain-action="content" on:click="toggle-content">Content</button><x-moving-list><x-moving-column><i $if="$show" slot="cell">Plain</i><input slot="cell" value="Initial"></x-moving-column></x-moving-list></article></template>`;

export const repeatedPlainSource = `<template component="x-repeat-card"><defs><state name="first" type="boolean" value="true"></state>
<handler name="toggle-first"><set name="first" expr:value="not $first"></set></handler></defs>
<section data-repeated-plain><button data-plain-action="first" on:click="toggle-first">First</button><template $if="$first"><slot name="cell"></slot></template><slot name="cell"></slot><footer>Tail</footer></section></template>
<template component="x-repeat-lazy-card"><section data-repeated-lazy><p><slot name="cell">First</slot></p><b><slot name="cell">Second</slot></b></section></template>
<template component="x-repeat-default-lazy"><section data-default-lazy><p><slot>First</slot></p><b><slot>Second</slot></b></section></template>
<template component="x-repeat-page"><article><x-repeat-card><i slot="cell">Plain</i><input slot="cell" value="Initial"></x-repeat-card><x-repeat-lazy-card><template slot="cell"><i>Fresh</i><input value="Fresh"></template></x-repeat-lazy-card><x-repeat-default-lazy><template slot=""><i>DefaultFresh</i></template></x-repeat-default-lazy></article></template>`;
