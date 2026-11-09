// Capture native Intl list and relative-time behavior through the shared JavaScript adapter.
import { writeFileSync } from 'node:fs';
import { createFormatValue } from '../../html-next/src/format.ts';
const formatValue = createFormatValue();
const cases = [];
function add(name, value, inputType, formatter, options = {}, locale = 'en-US', operation = 'format') {
  const result = formatValue(value, inputType, operation, ...(formatter === undefined ? [] : [formatter]), options, locale);
  cases.push({ name, value, negativeZero: Object.is(value, -0), inputType, formatter: formatter ?? null, options, locale, operation,
    expected: typeof result === 'symbol' || result === undefined ? null : result });
}
for (const type of ['conjunction', 'disjunction', 'unit']) for (const style of ['long', 'short', 'narrow']) {
  for (const value of [[], ['Alice'], ['Alice', 'Bob'], ['Alice', 'Bob', 'Carol']])
    add(`list ${type} ${style} ${value.length}`, value, 'list', 'list', { type, style });
  add(`list parts ${type} ${style}`, ['Alice', 'Bob', 'Carol'], 'list', 'list', { type, style }, 'en-US', 'formatParts');
}
add('inferred list', ['One', 'Two'], 'list', undefined);
for (const locale of ['de-DE', 'fr-CA', 'ja-JP', 'ar-EG']) add(`list locale ${locale}`, ['Alice', 'Bob', 'Carol'], 'list', 'list', {}, locale);
for (const options of [{ type: 'invalid' }, { style: 'invalid' }, { localeMatcher: 'invalid' }, { unknownOption: 'ignored' }]) add(`list options ${JSON.stringify(options)}`, ['Alice', 'Bob'], 'list', 'list', options);
for (const unit of ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second']) for (const numeric of ['always', 'auto']) {
  for (const value of [-1, 0, 1]) add(`relative ${unit} ${numeric} ${value}`, value, 'number', 'relativeTime', { unit, numeric });
  add(`relative parts ${unit} ${numeric}`, 1234.5, 'number', 'relativeTime', { unit, numeric }, 'en-US', 'formatParts');
}
for (const style of ['long', 'short', 'narrow']) for (const unit of ['day', 'quarter', 'seconds']) add(`relative style ${style} ${unit}`, -2.5, 'number', 'relativeTime', { unit, style });
add('relative negative zero', -0, 'number', 'relativeTime', { unit: 'day' });
add('relative negative zero parts', -0, 'number', 'relativeTime', { unit: 'day' }, 'en-US', 'formatParts');
for (const locale of ['de-DE', 'fr-CA', 'ja-JP', 'ar-EG', 'en-US-u-nu-arab']) {
  add(`relative locale ${locale}`, 3.5, 'number', 'relativeTime', { unit: 'day' }, locale);
  add(`relative parts locale ${locale}`, -3.5, 'number', 'relativeTime', { unit: 'day' }, locale, 'formatParts');
}
for (const options of [{}, { unit: 'days' }, { unit: 'invalid' }, { unit: 'day', numeric: 'invalid' }, { unit: 'day', style: 'invalid' },
  { unit: 'day', localeMatcher: 'invalid' }, { unit: 'day', numberingSystem: 'arab' }, { unit: 'day', numberingSystem: 'notreal' },
  { unit: 'day', numberingSystem: 'bad!' }, { unit: 'day', unknownOption: 'ignored' }])
  add(`relative options ${JSON.stringify(options)}`, 12, 'number', 'relativeTime', options);
for (const locale of ['en-US', 'zh-CN', 'ja-JP']) for (const value of [[], ['', ''], ['', 'Alice', ''], ['A', 'B', 'C']])
  add(`adjacent list parts ${locale} ${JSON.stringify(value)}`, value, 'list', 'list', { type: 'unit', style: 'narrow' }, locale, 'formatParts');
add('escaped list text', ['<tag>', '&', 'safe'], 'list', 'list');
add('escaped list parts', ['<tag>', '&', 'safe'], 'list', 'list', {}, 'en-US', 'formatParts');
// Independent public ulistfmt_format queries confirm Apple's RTL item isolation.
for (const item of cases) if (item.name === 'list locale ar-EG') item.platformExpected = { 'macos-icu-78.1': '\u2068Alice\u2069 و\u2068Bob\u2069 و\u2068Carol\u2069' };
writeFileSync(new URL('./fixtures/message-formatting.json', import.meta.url), JSON.stringify(cases, null, 2) + '\n');
console.log(`Captured ${cases.length} list and relative-time cases with Node ${process.version}, ICU ${process.versions.icu}`);
