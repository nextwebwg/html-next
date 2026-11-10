// Capture the supported JavaScript adapter's civil-value and native DateTimeFormat behavior.
import { writeFileSync } from 'node:fs';
import { createFormatValue } from '../../html-next/src/format.ts';
const formatValue = createFormatValue();
const cases = [];
function add(name, value, inputType, formatter, options = {}, locale = 'en-US', operation = 'format', end) {
  const args = [...(operation === 'formatRange' ? [end] : []), ...(formatter === undefined ? [] : [formatter]), options, locale];
  const result = formatValue(value, inputType, operation, ...args);
  cases.push({ name, value, inputType, formatter: formatter ?? null, options, locale, operation,
    ...(end === undefined ? {} : { end }), expected: typeof result === 'symbol' || result === undefined ? null : result });
}
for (const formatter of ['date', 'time', 'dateTime']) {
  add(`${formatter} instant default`, 1709210096789, 'number', formatter, { timeZone: 'UTC' });
  for (const style of ['full', 'long', 'medium', 'short']) {
    const options = { timeZone: 'UTC', ...(formatter !== 'time' ? { dateStyle: style } : {}), ...(formatter !== 'date' ? { timeStyle: style } : {}) };
    add(`${formatter} ${style}`, 1709210096789, 'number', formatter, options);
  }
}
for (const [inputType, value] of [['date', '2024-02-29'], ['time', '12:34:56.789'], ['datetime-local', '2024-02-29T12:34:56.789'], ['datetime', '2024-02-29T12:34:56.789Z']]) {
  const options = inputType === 'datetime' ? { timeZone: 'UTC' } : {};
  add(`inferred ${inputType}`, value, inputType, undefined, options);
  add(`parts ${inputType}`, value, inputType, undefined, options, 'en-US', 'formatParts');
}
for (const locale of ['de-DE', 'fr-CA', 'ja-JP', 'ar-EG', 'en-US-u-ca-buddhist', 'en-US-u-nu-arab']) add(`locale ${locale}`, '2024-02-29', 'string', 'date', { dateStyle: 'long' }, locale);
for (const timeZone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', '+05:30', '-0800', 'not-a-zone']) add(`zone ${timeZone}`, '2024-02-29T12:34:56Z', 'string', 'dateTime', { timeZone });
for (const hourCycle of ['h11', 'h12', 'h23', 'h24']) for (const value of ['00:05', '13:05']) add(`cycle ${hourCycle} ${value}`, value, 'string', 'time', { hour: '2-digit', minute: '2-digit', hourCycle });
for (const options of [
  { year: '2-digit', month: '2-digit', day: '2-digit' }, { weekday: 'long', era: 'short', year: 'numeric', month: 'long', day: 'numeric' },
  { month: 'narrow', weekday: 'narrow' }, { hour: 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 },
  { hour: 'numeric', dayPeriod: 'long' }, { hour: 'numeric', hour12: false }, { hour: 'numeric', hourCycle: 'h24', hour12: true },
  { calendar: 'buddhist', year: 'numeric', month: 'long', day: 'numeric' }, { calendar: 'notreal' }, { numberingSystem: 'arab' },
  { dateStyle: 'medium', year: 'numeric' }, { timeStyle: 'medium', hour: 'numeric' },
  { dateStyle: 'invalid' }, { month: 'invalid' }, { fractionalSecondDigits: 4 }, { hourCycle: 'invalid' },
  { calendar: 'bad!' }, { numberingSystem: 'bad!' }, { formatMatcher: 'invalid' }, { unknownOption: 'ignored' }
]) add(`options ${JSON.stringify(options)}`, '2024-02-29T12:34:56.789Z', 'string', 'dateTime', { timeZone: 'UTC', ...options });
for (const timeZoneName of ['short', 'long', 'shortOffset', 'longOffset', 'shortGeneric', 'longGeneric']) add(`zone name ${timeZoneName}`, 1709210096789, 'number', 'time', { timeZone: 'America/Los_Angeles', hour: 'numeric', timeZoneName });
for (const value of ['0001-01-01', '1000-03-01', '10000-01-01', '2023-02-29', '2024-13-01', '0000-01-01', '2024-02-29junk']) add(`civil ${value}`, value, 'string', 'date');
for (const value of ['23:59:59.999', '24:00', '12:60', '12:34:60', '12:34:56.1234']) add(`clock ${value}`, value, 'string', 'time');
add('civil rejects authored zone', '2024-02-29', 'string', 'date', { timeZone: 'UTC' });
add('civil rejects zone name', '12:30', 'string', 'time', { timeZoneName: 'short' });
add('date rejects time fields', '2024-02-29', 'string', 'date', { hour: 'numeric' });
add('time rejects date fields', '12:30', 'string', 'time', { year: 'numeric' });
for (const [value, end] of [['2024-02-29', '2024-03-02'], ['2024-02-29', '2024-02-29'], ['2024-03-02', '2024-02-29']]) add(`range ${value} ${end}`, value, 'string', 'date', {}, 'en-US', 'formatRange', end);
for (const hourCycle of ['h11', 'h12', 'h23', 'h24']) add(`styled cycle ${hourCycle}`, 1709210096789, 'number', 'dateTime', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC', hourCycle });
for (const locale of ['en-US', 'ja-JP', 'fr-FR', 'en-US-u-hc-h24']) for (const hour12 of [true, false])
  add(`styled hour12 ${locale} ${hour12}`, 1709179500000, 'number', 'time', { timeStyle: 'medium', timeZone: 'UTC', hour12 }, locale);
for (const timeZone of ['america/los_angeles', 'asia/kolkata', 'Pacific Standard Time', '+24:00', '+05', 'GMT+05:30'])
  add(`zone validation ${timeZone}`, 1709210096789, 'number', 'time', { hour: 'numeric', timeZone });
for (const [value, end] of [['0001-01-01', '0001-01-03'], ['1000-02-28', '1000-03-02'], ['10000-01-01', '10000-01-03']])
  add(`historic range ${value}`, value, 'string', 'date', {}, 'en-US', 'formatRange', end);
for (const [value, end] of [[1709210096789, 1709210096789], [1709210096789, 1709213696789]])
  add(`instant range ${value} ${end}`, value, 'number', 'dateTime', { timeZone: 'UTC' }, 'en-US', 'formatRange', end);
for (const timeZoneName of ['short', 'long']) add(`default fields plus zone ${timeZoneName}`, 1709210096789, 'number', 'dateTime', { timeZone: 'UTC', timeZoneName });
for (const timeStyle of ['long', 'full']) {
  add(`civil clock parts ${timeStyle}`, '12:34:56', 'time', undefined, { timeStyle }, 'en-US', 'formatParts');
  add(`civil datetime parts ${timeStyle}`, '2024-02-29T12:34:56', 'datetime-local', undefined, { dateStyle: 'long', timeStyle }, 'en-US', 'formatParts');
  add(`civil collapsed range ${timeStyle}`, '2024-02-29T12:34:56', 'datetime-local', undefined, { dateStyle: 'long', timeStyle }, 'en-US', 'formatRange', '2024-02-29T12:34:56');
  add(`civil clock ${timeStyle}`,  '12:34:56', 'time', undefined, { timeStyle });
  add(`civil datetime ${timeStyle}`, '2024-02-29T12:34:56', 'datetime-local', undefined, { dateStyle: 'long', timeStyle });
  add(`civil range ${timeStyle}`, '2024-02-29T12:34:56', 'datetime-local', undefined, { dateStyle: 'long', timeStyle }, 'en-US', 'formatRange', '2024-03-01T13:35:57');
}
// Apple's system ICU 78.1 uses different CLDR patterns from upstream ICU 78.3.
// These three pattern differences were queried independently through udat_toPattern
// and udatpg_getBestPatternWithOptions, without the HTML Next adapter.
for (const item of cases) {
  let native;
  if (item.operation !== 'formatRange' && typeof item.expected === 'string' && item.expected.startsWith('Feb ') && item.expected.includes(':') && /, [^,]+$/.test(item.expected))
    native = item.expected.replace(/, ([^,]+)$/, ' at $1');
  if (Array.isArray(item.expected) && item.expected.some(part => part.type === 'month' && part.value === 'Feb') && item.expected.some(part => part.type === 'hour') && item.expected.some(part => part.type === 'year')) {
    native = structuredClone(item.expected);
    const year = native.findIndex(part => part.type === 'year');
    if (native[year + 1]?.type === 'literal' && native[year + 1].value === ', ') native[year + 1].value = ' at ';
  }
  if (item.name === 'instant range 1709210096789 1709210096789') native = 'Feb 29, 2024 at 12:34:56 PM';
  if (item.name === 'locale ar-EG') native = '٢٩ فبراير، ٢٠٢٤';
  if (item.name === 'options {"month":"narrow","weekday":"narrow"}') native = 'F, T';
  if (native !== undefined) item.platformExpected = { 'macos-icu-78.1': native };
}
writeFileSync(new URL('./fixtures/date-formatting.json', import.meta.url), JSON.stringify(cases, null, 2) + '\n');
console.log(`Captured ${cases.length} date cases with Node ${process.version}, ICU ${process.versions.icu}`);
