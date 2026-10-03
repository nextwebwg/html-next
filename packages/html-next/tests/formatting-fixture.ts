/** Shared behavior fixture for native, Vue, React, and Node rendering. */
export const formattingSource = `<template component="x-formatting"><defs>
  <state name="optionalAmount" type="number" value="12"></state>
  <state name="amount" type="number" value="12.5"></state>
  <state name="clock" type="time" value="01:46:40"></state>
  <state name="day" type="date" value="2026-10-03"></state>
  <state name="instant" type="datetime" value="2026-10-03T13:45Z"></state>
  <state name="elapsed" type="duration" value="1500ms"></state>
  <state name="names" type="list(string)" value="['Ada', 'Lin']"></state>
  <state name="locale" type="string" value="en-US"></state>
  <state name="currency" type="string" value="USD"></state>
  <computed name="label" from="format($amount, { style: 'currency', currency: $currency }, $locale)"></computed>
  <handler name="change"><set name="amount" value="25"></set><set name="locale" value="fr-FR"></set><set name="currency" value="EUR"></set><set name="names" expr:value="['Bea', 'Cy']"></set></handler>
<handler name="invalid"><set name="optionalAmount" value="0"></set><set name="currency" value="INVALID"></set><set name="names" expr:value="['Zed']"></set></handler>
</defs><section from:aria-label="$label"><button type="button" on:click="change">Change</button><button type="button" on:click="invalid">Invalid currency</button>
  <p data-format="currency">Total: {format($amount, 'currency', { currency: $currency }, $locale)} due.</p>
  <p data-format="mixed">Total: {format($amount, 'currency', { currency: $currency }, $locale)} for {format($names, 'list', {}, $locale)}.</p>
  <p data-format="inferred">$label</p>
  <p data-format="time">{format($clock, { timeStyle: 'long', hour12: false }, $locale)}</p>
  <p data-format="date">{format($day, { dateStyle: 'long' }, $locale)}</p>
  <p data-format="dateTime">{format($instant, 'dateTime', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }, $locale)}</p>
  <p data-format="duration">{format($elapsed, { style: 'long' }, $locale)}</p>
  <p data-format="list">{format($names, { style: 'long' }, $locale)}</p>
  <p data-format="relativeTime">{format(-1, 'relativeTime', { unit: 'day', numeric: 'auto' }, $locale)}</p>
  <p data-format="percent">{format(0.15, 'percent', {}, $locale)}</p>
  <p data-format="unit">{format($amount, 'unit', { unit: 'meter' }, $locale)}</p>
  <p data-format="plural">{format($names.length, 'plural', { forms: { one: '# name', other: '# names' } }, $locale)}</p>
  <p data-format="displayName">{format('CA', 'displayName', { type: 'region' }, $locale)}</p>
  <p data-format="range">{formatRange(1, $amount, 'number', {}, $locale)}</p>
  <p data-format="parts"><span $each="part of formatParts($amount, 'currency', { currency: $currency }, $locale)">$part.value</span></p>
<p data-format="shadow"><span $each="formatValue of names">{format(12, 'number', {}, $locale)}</span></p>
<p data-format="withShadow" $with="$amount as formatValue">{format($formatValue, 'number', {}, $locale)}</p>
<p data-format="matchShadow"><template $match="$amount as formatValue"><span $when="$formatValue &gt; 0">{format($formatValue, 'number', {}, $locale)}</span></template></p>
<p data-format="scoped" $with="12 as price">Total: {format($price, 'currency', { currency: $currency }, $locale)} for {format($names, 'list', {}, $locale)}.</p>
<p data-format="eachScoped" $each="price of [12]">{format($price, 'currency', { currency: $currency }, $locale)}</p>
<p data-format="absent">{format($optionalAmount = 0 ? null : $optionalAmount, 'number', {}, $locale)}</p>
<p data-format="emptyList">{concat('Names: ', format([], {}, $locale))}</p>
<p data-format="stringList">{format([$currency, concat('A', 'da')], {}, $locale)}</p>
</section></template>`;

export const formattingProbe = `({ label: root.getAttribute('aria-label'), values: Object.fromEntries(Array.from(root.querySelectorAll('[data-format]'), element => [element.getAttribute('data-format'), element.textContent])) })`;
