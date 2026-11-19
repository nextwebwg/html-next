// Capture the shared adapter's duration records, constructor validation and structured fields.
import { readFileSync, writeFileSync } from 'node:fs';
import { createFormatValue } from '../../html-next/src/format.ts';
const formatValue = createFormatValue();
const cases = [];
function add(name, value, options = {}, locale = 'en-US', inputType = 'object', formatter = 'duration') {
  for (const operation of ['format', 'formatParts']) {
    const result = formatValue(value, inputType, operation, ...(formatter === null ? [options, locale] : [formatter, options, locale]));
    cases.push({ name: `${name} ${operation}`, value, inputType, formatter, operation, options, locale,
      expected: typeof result === 'symbol' || result === undefined ? null : result });
  }
}
const all = { years: 1, months: 2, weeks: 3, days: 4, hours: 5, minutes: 6, seconds: 7, milliseconds: 123, microseconds: 456, nanoseconds: 789 };
for (const locale of ['en-US', 'de-DE', 'fr-FR', 'ja-JP', 'ar-EG', 'fa-IR', 'da-DK', 'fi-FI']) {
  for (const style of ['long', 'short', 'narrow', 'digital']) add(`${locale} ${style}`, all, { style }, locale);
}
for (const value of [{ seconds: 0 }, { seconds: 90 }, { hours: 12345 }, { hours: 1, seconds: 3 }, { hours: 0, minutes: 0, seconds: -2 }, { years: -1, hours: -2 }, { milliseconds: 1234, microseconds: 567, nanoseconds: 890 }, { nanoseconds: 1 }, { seconds: 1, nanoseconds: 1 }, { seconds: 1, milliseconds: 999 }, { seconds: 9007199254740991 }, { seconds: 9007199254740992 }, { nanoseconds: 9007199254740991000000 }, { years: 4294967295 }, { years: 4294967296 }, {}, { hours: 1, minutes: -2 }, { seconds: 1.5 }, { hours: null }, { hours: '2' }, { hours: true }, { seconds: [] }, { seconds: {} }, { invalid: 1 }, [], '1s']) {
  for (const style of ['short', 'digital']) add(`record ${JSON.stringify(value)} ${style}`, value, { style });
}
for (const options of [
  { hours: 'numeric' }, { minutes: 'numeric' }, { seconds: 'numeric' }, { hours: '2-digit' }, { seconds: '2-digit' },
  { milliseconds: 'numeric' }, { microseconds: 'numeric' }, { nanoseconds: 'numeric' },
  { seconds: 'long', milliseconds: 'numeric' }, { milliseconds: 'long', microseconds: 'numeric' }, { microseconds: 'narrow', nanoseconds: 'numeric' },
  { style: 'digital', hoursDisplay: 'auto', minutesDisplay: 'auto', secondsDisplay: 'auto' },
  { daysDisplay: 'always', style: 'digital' }, { hours: 'numeric', hoursDisplay: 'auto', minutesDisplay: 'auto', secondsDisplay: 'auto' },
  { style: 'digital', fractionalDigits: 0 }, { style: 'digital', fractionalDigits: 2 }, { style: 'digital', fractionalDigits: 9 }, { style: 'digital', fractionalDigits: 2.5 },
  { style: 'digital', numberingSystem: 'arab' }, { style: 'digital', numberingSystem: 'arabext' }, { style: 'digital', numberingSystem: 'latn' },
  { style: 'digital', numberingSystem: 'roman' }, { style: 'digital', numberingSystem: 'hans' }, { style: 'digital', numberingSystem: 'ARAB' }, { style: 'digital', numberingSystem: 'unknown' },
  { style: 'invalid' }, { years: 'numeric' }, { hours: 'fractional' }, { hours: 'numeric', minutes: 'long' },
  { milliseconds: 'numeric', microseconds: 'long' }, { milliseconds: 'numeric', millisecondsDisplay: 'always' },
  { secondsDisplay: 'invalid' }, { fractionalDigits: 10 }, { fractionalDigits: -1 }, { localeMatcher: 'invalid' }, { numberingSystem: 'bad!' }
]) {
  add(`options ${JSON.stringify(options)}`, all, options);
  add(`negative options ${JSON.stringify(options)}`, { minutes: -1, milliseconds: -5 }, options);
  add(`zero options ${JSON.stringify(options)}`, { seconds: 0 }, options);
}
for (const value of ['3661.125s', '-1.25s', '.000001s', '1250ms', '0s', '-0s', '+1s', '1e3ms']) {
  for (const style of ['long', 'digital']) add(`CSS ${value} ${style}`, value, { style }, 'en-US', 'duration', null);
}
const platforms = JSON.parse(readFileSync(new URL('./fixtures/duration-platform-data.json', import.meta.url), 'utf8'));
for (const item of cases) if (platforms[item.name]) item.platformExpected = platforms[item.name];
writeFileSync(new URL('./fixtures/duration-formatting.json', import.meta.url), JSON.stringify(cases, null, 2) + '\n');
console.log(`Captured ${cases.length} duration cases with Node ${process.version}, ICU ${process.versions.icu}`);
