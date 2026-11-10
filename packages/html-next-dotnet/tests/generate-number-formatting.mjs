// Capture the supported JavaScript host's native NumberFormat behavior for the .NET adapter.
// Run from any directory with Node 24; review changes when the host ICU data changes.
import {writeFileSync} from 'node:fs';
const cases=[];
const add=(name,value,options,locale='en-US',operation='format',end)=>{
 let expected=null;try{const f=new Intl.NumberFormat(locale,options);expected=operation==='formatRange'?f.formatRange(value,end):operation==='formatParts'?f.formatToParts(value):f.format(value);}catch{}
 cases.push({name,value,options,locale,operation,...(end===undefined?{}:{end}),expected});
};
for(const roundingMode of ['ceil','floor','expand','trunc','halfCeil','halfFloor','halfExpand','halfTrunc','halfEven']) for(const value of [1.25,-1.25]) add(`${roundingMode} ${value}`,value,{maximumFractionDigits:1,roundingMode});
for(const p of ['auto','morePrecision','lessPrecision']) for(const value of [0.012345,12345]) add(`${p} ${value}`,value,{minimumFractionDigits:1,maximumFractionDigits:2,minimumSignificantDigits:2,maximumSignificantDigits:3,roundingPriority:p});
for(const increment of [1,2,5,10,20,25,50,100,200,250,500,1000,2000,2500,5000]) add(`increment ${increment}`,123.456,{minimumFractionDigits:2,maximumFractionDigits:2,roundingIncrement:increment});
for(const signDisplay of ['auto','never','always','exceptZero','negative']) for(const value of [0,-0,-1,1]) add(`accounting ${signDisplay} ${Object.is(value,-0)?'-0':value}`,Object.is(value,-0)?'-0':value,{style:'currency',currency:'USD',currencySign:'accounting',signDisplay});
for(const notation of ['standard','scientific','engineering','compact']) for(const useGrouping of [false,true,'auto','always','min2','false','true']) add(`${notation} grouping ${useGrouping}`,12345,{notation,useGrouping});
for(const options of [
 {notation:'compact'}, {notation:'compact',compactDisplay:'long'},
 {minimumFractionDigits:2,trailingZeroDisplay:'stripIfInteger'},
 {minimumFractionDigits:2,maximumSignificantDigits:4,roundingPriority:'morePrecision',trailingZeroDisplay:'stripIfInteger'},
 {minimumSignificantDigits:2,maximumSignificantDigits:3},
 {minimumSignificantDigits:2,minimumFractionDigits:101},
 {minimumSignificantDigits:2,minimumFractionDigits:5,maximumFractionDigits:2},
 {roundingIncrement:2,minimumFractionDigits:2},{notation:'compact',roundingIncrement:2},
 {minimumFractionDigits:'2'},{minimumFractionDigits:[2]},{minimumFractionDigits:[]},
 {minimumFractionDigits:null},{minimumFractionDigits:true},
 {maximumFractionDigits:100},{maximumFractionDigits:101},{minimumIntegerDigits:21},{minimumIntegerDigits:22},
 {maximumSignificantDigits:0},{roundingIncrement:3},{roundingMode:'invalid'},
 {roundingPriority:'invalid'},{trailingZeroDisplay:'invalid'}, {style:'decimal',unit:'invalid'},
 {style:'decimal',currency:'bad!'},{currencyDisplay:'invalid'},{currencySign:'invalid'},
 {unitDisplay:'invalid'},{notation:'invalid'},{compactDisplay:'invalid'},{signDisplay:'invalid'},
 {useGrouping:[]},{useGrouping:{}},{useGrouping:['auto']},{useGrouping:1},{useGrouping:0},{useGrouping:null},{useGrouping:''},{localeMatcher:'invalid'},
 {numberingSystem:'arab'},{numberingSystem:'notreal'},{numberingSystem:'bad!'},
 {numberingSystem:'roman'},{numberingSystem:'native'},{numberingSystem:'finance'},
 {numberingSystem:'hans'},{numberingSystem:'hanidec'},{numberingSystem:'ARAB'},
 {style:'currency',currency:'JPY'}, {style:'currency',currency:'kwd'},
 {style:'currency',currency:'USD',currencyDisplay:'code'}, {style:'currency',currency:'USD',currencyDisplay:'name'},
 {maximumfractiondigits:0,unknownOption:'ignored'}]) add(JSON.stringify(options),12,options);
for(const locale of ['de-DE','fr-CA','hi-IN','ar-EG','en-US-u-nu-arab','en_US','en-a-foo-a-bar','en-abc','en-x-foo','en-u-nu-roman','en-u-nu-native','en-u-nu-notreal','en-u-a1','en-u-1a','en-u-abc-abc','en-u-ca-true-ca-false','en-Latn-Latn','en-1901-1901','en-t-abc','en-t-en-US','en-US-u-nu-arab']) add(`locale ${locale}`,1234.5,{},locale);
add('unsupported option overrides locale extension',1234.5,{numberingSystem:'notreal'},'en-u-nu-arab');
for(const unit of ['acre','bit','byte','celsius','centimeter','day','degree','fahrenheit','fluid-ounce','foot','gallon','gigabit','gigabyte','gram','hectare','hour','inch','kilobit','kilobyte','kilogram','kilometer','liter','megabit','megabyte','meter','microsecond','mile','mile-scandinavian','milliliter','millimeter','millisecond','minute','month','nanosecond','ounce','percent','petabyte','pound','second','stone','terabit','terabyte','week','yard','year','mile-per-hour','percent-per-second','meter-per-meter','meter-per-hour-per-second']) add(`unit ${unit}`,2.5,{style:'unit',unit,unitDisplay:'long'});
for(const options of [{},{style:'currency',currency:'USD'},{notation:'scientific'},{notation:'compact'},{style:'unit',unit:'percent'},{style:'currency',currency:'USD',currencySign:'accounting'}]) add(`parts ${JSON.stringify(options)}`,-1234.5,options,'en-US','formatParts');
for(const [value,end] of [[1,3],[1,1],[1.001,1.002],[3,1],[-1,1]]) add(`range ${value} ${end}`,value,{style:'currency',currency:'USD'},'en-US','formatRange',end);
writeFileSync(new URL('./fixtures/number-formatting.json', import.meta.url),JSON.stringify(cases,null,2)+'\n');
