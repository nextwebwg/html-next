/** Shared public inputs for server and converted-component entry selection. */
const outlet = (expression: string) => `<slot of="${expression}" name="cell" text="7">Empty</slot>`;
const paragraph = (name: string, content: string) => `<p data-owned="${name}">${content}</p>`;
export const ownedEntryFiles: Readonly<Record<string, string>> = {
  "entry-column.html": `<template component="x-entry-column"><defs><slot name="cell"><prop name="text" type="string">Text.</prop></slot></defs><span>Column</span></template>`,
  "entry-action.html": `<template component="x-entry-action"><defs><slot name="cell"><prop name="text" type="integer">Number.</prop></slot></defs><span>Action</span></template>`,
  "entries.html": `<link rel="component" href="./entry-column.html"><link rel="component" href="./entry-action.html">
<template component="x-entries"><defs><prop name="choose" type="boolean">Choose columns.</prop><prop name="position" type="integer">Position.</prop>
<slot accepts="x-entry-column" as="columns"></slot><slot name="actions" accepts="x-entry-action" as="actions"></slot>
<computed name="chosen" from="$columns[$position]"></computed>
<computed name="either" from="$choose ? $columns[$position] : $actions[0]"></computed>
<computed name="selected" from="$choose ? $columns : $actions"></computed>
</defs><section data-owned-entries>
${paragraph("indexed", outlet("$columns[$position]"))}
${paragraph("computed", outlet("$chosen"))}
${paragraph("with", `<template $with="$columns[$position] as chosen">${outlet("$chosen")}</template>`)}
${paragraph("match", `<template $match="$columns[$position] as chosen"><template $when="true">${outlet("$chosen")}</template></template>`)}
${paragraph("conditional", outlet("$either"))}
${paragraph("list-alias", `<template $each="entry of $selected">${outlet("$entry")}</template>`)}
${paragraph("shadow", `<template $each="columns of $columns">${outlet("$columns")}</template>`)}
${paragraph("new-list", `<template $each="entry of [$columns[1], null, $actions[0]]">${outlet("$entry")}</template>`)}
${paragraph("null", outlet("null"))}${paragraph("missing", outlet("$columns[99]"))}
${paragraph("default", outlet("default($columns[99], $actions[0])"))}
</section></template>`,
};
export const ownedEntryInvocation = `<x-entries from:choose="$values.length > 2" from:position="$values.length = 2 ? 1 : 0">
<x-entry-column><template slot="cell">C1:{$text}:{$text = '7'}</template></x-entry-column>
<x-entry-column><template slot="cell">C2:{$text}:{$text = '7'}</template></x-entry-column>
<x-entry-action slot="actions"><template slot="cell">A:{$text}:{$text = '7'}</template></x-entry-action></x-entries>`;
export const ownedEntryInitial = ["C2:7:true", "C2:7:true", "C2:7:true", "C2:7:true", "A:7:false", "A:7:false", "C1:7:trueC2:7:true", "C2:7:trueEmptyA:7:false", "Empty", "Empty", "A:7:false"];
export const ownedEntryChanged = ["C1:7:true", "C1:7:true", "C1:7:true", "C1:7:true", "C1:7:true", "C1:7:trueC2:7:true", "C1:7:trueC2:7:true", "C2:7:trueEmptyA:7:false", "Empty", "Empty", "A:7:false"];
