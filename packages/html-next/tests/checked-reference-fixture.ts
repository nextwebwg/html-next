export const checkedReferenceSource = `<template component="x-checked-reads"><defs>
  <state name="draft" type="object({ name: string, 'odd.key': string, nested: object({ name: string }) })" from="{ name: 7, 'odd.key': 7, nested: 2 }"></state>
  <state name="rows" type="list(object({ name: string }))" from="[{ name: 7 }]"></state>
  <state name="key" type="string" value="name"></state>
  <state name="index" type="integer" value="0"></state>
  <state name="choose" type="boolean" value="false"></state>
  <state name="seeded" type="string" from="false ? $draft.name : 'Seeded'"></state>
  <state name="partial" type="object({ name: string, count: number, flag: boolean })" from="{}"></state>
  <state name="nullFields" type="object({ name: string, count: number, flag: boolean })" from="{ name: null, count: null, flag: null }"></state>
  <computed name="label" from="$choose ? $draft.name : 'OK'"></computed>
  </defs><section>
  <output id="lazy">{false ? $draft.name : 'OK'}</output>
  <output id="and">{false and $draft.name}</output>
  <output id="or">{true or $draft.name}</output>
  <output id="fallback">{default('present', $draft.name)}</output>
  <output id="computed-key">{$draft[$key]}</output>
  <output id="computed-index">{$rows[$index].name}</output>
  <output id="bad-fallback">{default($draft[$key], 'fallback')}</output>
  <output id="quoted-key">{$draft['odd.key']}</output>
  <output id="safe-missing">{default($draft.nested[$key], 'missing')}</output>
  <output id="label">{$label}</output><output id="seeded">{$seeded}</output>
  <output id="missing-number">{$partial.count + 1}</output><output id="null-number">{$nullFields.count + 1}</output>
  <output id="missing-prefix">{$partial.name ^= 'A'}</output><output id="null-prefix">{$nullFields.name ^= 'A'}</output>
  <output id="empty-object">{$partial ? 'yes' : 'no'}</output><output id="null-boolean">{true and $nullFields.flag}</output>
  <output id="missing-equality">{$partial.count = null}</output><output id="missing-inequality">{$partial.count != null}</output>
  <output id="missing-self-equality">{$partial.count = $partial.count}</output><output id="missing-not-equality">{not ($partial.count = $partial.count)}</output>
  <output id="null-equality">{$nullFields.count = null}</output><output id="missing-nested-equality">{($partial.count = null) = false}</output>
  <output id="missing-equality-fallback">{default($partial.count = null, true)}</output>
  <p $each="row of $rows"><output id="alias-lazy">{false ? $row.name : 'Alias'}</output><output id="alias-key">{$row[$key]}</output></p>
  </section></template>`;

export const checkedReferenceInitial = {
  lazy: "OK", and: "false", or: "true", fallback: "present", "computed-key": "", "computed-index": "",
  "bad-fallback": "", "quoted-key": "", "safe-missing": "missing", label: "OK", seeded: "Seeded",
  "alias-lazy": "Alias", "alias-key": "",
  "missing-number": "", "null-number": "", "missing-prefix": "", "null-prefix": "", "empty-object": "no", "null-boolean": "false",
  "missing-equality": "", "missing-inequality": "", "missing-self-equality": "", "missing-not-equality": "true",
  "null-equality": "true", "missing-nested-equality": "", "missing-equality-fallback": "true",
};
