// Capture display-name fallback and precision-sensitive plural behavior through the shared adapter.
import { writeFileSync } from 'node:fs';
import { createFormatValue } from '../../html-next/src/format.ts';
const formatValue = createFormatValue();
const cases = [];
function add(name, value, formatter, options, locale = 'en-US') {
  const inputType = typeof value === 'number' ? 'number' : 'string';
  const result = formatValue(value, inputType, 'format', formatter, options, locale);
  cases.push({ name, value, inputType, formatter, options, locale,
    status: typeof result === 'symbol' ? 'invalid' : result === undefined ? 'absent' : 'value',
    expected: typeof result === 'symbol' || result === undefined ? null : result });
}
for (const [type, codes] of Object.entries({ language: ['en', 'en-US', 'zh-Hant', 'fr-CA', 'iw', 'zz', 'ZZ', 'zz-US', 'en-XX', 'en-Zzzz', 'sh', 'sh-Cyrl', 'sh-BA', 'mo', 'tl', 'aam', 'en-Qaai', 'en-BU', 'und', 'root', 'en-US-u-ca-buddhist'],
  region: ['US', 'GB', '419', 'ZZ', 'XX', 'us', 'invalid'], script: ['Latn', 'Cyrl', 'Zzzz', 'Qaaa', 'latn', 'invalid'],
  currency: ['USD', 'eur', 'ZZZ', 'XXX', 'bad!'], calendar: ['gregory', 'buddhist', 'islamic-civil', 'islamicc', 'notreal', 'gregorian'],
  dateTimeField: ['era', 'year', 'quarter', 'month', 'weekOfYear', 'weekday', 'day', 'dayPeriod', 'hour', 'minute', 'second', 'timeZoneName', 'invalid'] })) {
  for (const code of codes) for (const fallback of ['code', 'none']) add(`name ${type} ${code} ${fallback}`, code, 'displayName', { type, fallback });
}
for (const style of ['long', 'short', 'narrow']) for (const languageDisplay of ['dialect', 'standard']) add(`language ${style} ${languageDisplay}`, 'en-US', 'displayName', { type: 'language', style, languageDisplay });
for (const locale of ['de-DE', 'fr-CA', 'ja-JP', 'ar-EG']) add(`name locale ${locale}`, 'US', 'displayName', { type: 'region' }, locale);
for (const options of [{}, { type: 'invalid' }, { type: 'region', style: 'invalid' }, { type: 'region', fallback: 'invalid' }, { type: 'region', languageDisplay: 'invalid' }, { type: 'region', localeMatcher: 'invalid' }]) add(`invalid name options ${JSON.stringify(options)}`, 'US', 'displayName', options);
add('name requires a string', 12, 'displayName', { type: 'region' });
const forms = { zero: 'zero: #', one: 'one: #', two: 'two: #', few: 'few: #', many: 'many: #', other: 'other: #' };
for (const locale of ['en-US', 'fr-FR', 'ru-RU', 'ar-EG']) for (const value of [0, 1, 2, 3, 5, 11, 21, 1.5]) add(`plural ${locale} ${value}`, value, 'plural', { forms }, locale);
for (const value of [1, 2, 3, 4, 11, 21, 22, 23]) add(`ordinal ${value}`, value, 'plural', { type: 'ordinal', forms });
for (const options of [{ maximumFractionDigits: 0 }, { minimumFractionDigits: 1 }, { maximumSignificantDigits: 1 },
  { maximumFractionDigits: 1, roundingMode: 'halfEven' }, { minimumFractionDigits: 2, maximumFractionDigits: 2, roundingIncrement: 5 },
  { style: 'currency', currency: 'USD' }, { style: 'percent' }, { notation: 'compact' }, { numberingSystem: 'arab' }]) add(`plural precision ${JSON.stringify(options)}`, 1.004, 'plural', { forms, ...options });
add('plural fallback other', 1, 'plural', { forms: { other: '# item(s)' } });
add('plural substitutes all hashes literally', 2, 'plural', { forms: { other: '$# & # <items>' } });
for (const options of [{}, { forms: {} }, { forms: [] }, { forms: { one: 'one' } }, { forms: { other: 12 } },
  { forms: { other: 'other', unknown: 'bad' } }, { forms, type: 'invalid' }, { forms, maximumFractionDigits: 101 }]) add(`invalid plural ${JSON.stringify(options)}`, 1, 'plural', options);
// Exact vendor locale data, independently queried with public uldn APIs.
for (const item of cases) {
  if (item.name === 'name language zh-Hant code' || item.name === 'name language zh-Hant none') item.platformExpected = { 'macos-icu-78.1': 'Chinese, Traditional' };
  if (item.name === 'name language sh-BA code' || item.name === 'name language sh-BA none') item.platformExpected = { 'macos-icu-78.1': 'Serbian (Latin, Bosnia)' };
  if (item.name === 'name language en-BU code' || item.name === 'name language en-BU none') item.platformExpected = { 'macos-icu-78.1': 'English (Myanmar)' };
  if (item.name === 'name language zz-US code') item.platformExpected = { 'macos-icu-78.1': 'zz (US)' };
  if (item.name === 'name language und code' || item.name === 'name language und none') item.platformExpected = { 'macos-icu-78.1': 'Root' };
  if (item.name === 'language long standard') item.platformExpected = { 'macos-icu-78.1': 'English (US)' };
}
writeFileSync(new URL('./fixtures/name-plural-formatting.json', import.meta.url), JSON.stringify(cases, null, 2) + '\n');
console.log(`Captured ${cases.length} name and plural cases with Node ${process.version}, ICU ${process.versions.icu}`);
