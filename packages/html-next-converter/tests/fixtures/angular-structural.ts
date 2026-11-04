/** Native root choices keep their controller while Angular owns each branch view. */
export const angularStructural = `<template component="ui-branch">
  <defs>
    <prop name="href" type="string">An optional link destination.</prop>
    <prop name="disabled" type="boolean" default="false">Whether activation is unavailable.</prop>
    <state name="count" type="integer" value="0"></state>
    <event name="saved" type="integer">The activation count.</event>
    <handler name="activate"><set name="count" expr:value="$count + 1"></set><dispatch event="saved" expr:value="$count"></dispatch></handler>
  </defs>
  <template $match>
    <a $when="$href" from:href="{ true: null, false: $href }[concat($disabled)]" from:aria-disabled="$disabled" on:click="activate"><slot></slot><output>{$count}</output><slot name="badge"></slot></a>
    <button $else type="button" on:click="activate"><slot></slot><output>{$count}</output><slot name="badge"></slot></button>
  </template>
  <style>:host { color: rgb(1, 2, 3); }</style>
</template>
<template component="ui-tree-node">
  <defs><prop name="node" type="object({ kind: string, label: string, ... })" required>The recursive node.</prop></defs>
  <template $match>
    <section $when="$node.kind = 'branch'"><h2>{$node.label}</h2><ui-tree-node $each="child of $node.children" from:node="$child"></ui-tree-node></section>
    <span $else>{$node.label}</span>
  </template>
</template>
<template component="ui-tree-parent">
  <defs><prop name="current" type="object({ kind: string, label: string, ... })">The node, once available.</prop></defs>
  <div><ui-tree-node from:node="$current"></ui-tree-node></div>
</template>
<template component="ui-slot-bin">
  <div><aside class="badge"><slot name="badge"></slot></aside></div>
</template>
<template component="ui-branch-holder">
  <section><ui-slot-bin><ui-branch $ref="action" slot="badge" href="/nested" class="child">Projected native child</ui-branch></ui-slot-bin></section>
</template>`;
