import type { GeneratedArtifact } from "../generate.js";

const STYLE_OBJECT_SOURCE = `function propertyName(name) {
  return name.startsWith('--') ? name : name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()).replace(/^Ms/, 'ms');
}
export function styleObject(value) {
  if (value == null) return {};
  if (typeof value === 'object') {
    if (!NORMALIZE_STYLE_NUMBERS) return value;
    let result = value;
    for (const [name, number] of Object.entries(value)) {
      if (typeof number !== 'number') continue;
      if (result === value) result = { ...value };
      result[name] = String(number) + (name.startsWith('--') || styleUnitless(name, value) ? '' : 'px');
    }
    return result;
  }
  const style = createStyle();
  style.cssText = String(value);
  return Object.fromEntries(Array.from({ length: style.length }, (_, index) => {
    const name = style.item(index);
    return [propertyName(name), style.getPropertyValue(name) + (style.getPropertyPriority(name) === 'important' ? ' !important' : '')];
  }));
}
export function styleBinding(value, ref) {
  return { style: value, ref: element => { applyStylePriority(element, value); return ref?.(element); } };
}
export function applyStylePriority(element, value) {
  if (element === null || value === null || typeof value !== 'object') return;
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== 'string' || !text.trimEnd().endsWith('!important')) continue;
    const name = key.startsWith('--') ? key : key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()).replace(/^ms-/, '-ms-');
    element.style.setProperty(name, text.trimEnd().slice(0, -10).trimEnd(), 'important');
  }
}
`;

// Numeric style units are framework input semantics; CSS parsing stays with CSSOM.
const REACT_UNITLESS = {"animationIterationCount": true, "aspectRatio": true, "borderImageOutset": true, "borderImageSlice": true, "borderImageWidth": true, "boxFlex": true, "boxFlexGroup": true, "boxOrdinalGroup": true, "columnCount": true, "columns": true, "flex": true, "flexGrow": true, "flexPositive": true, "flexShrink": true, "flexNegative": true, "flexOrder": true, "gridArea": true, "gridRow": true, "gridRowEnd": true, "gridRowSpan": true, "gridRowStart": true, "gridColumn": true, "gridColumnEnd": true, "gridColumnSpan": true, "gridColumnStart": true, "fontWeight": true, "lineClamp": true, "lineHeight": true, "opacity": true, "order": true, "orphans": true, "scale": true, "tabSize": true, "widows": true, "zIndex": true, "zoom": true, "fillOpacity": true, "floodOpacity": true, "stopOpacity": true, "strokeDasharray": true, "strokeDashoffset": true, "strokeMiterlimit": true, "strokeOpacity": true, "strokeWidth": true, "MozAnimationIterationCount": true, "MozBoxFlex": true, "MozBoxFlexGroup": true, "MozLineClamp": true, "msAnimationIterationCount": true, "msFlex": true, "msZoom": true, "msFlexGrow": true, "msFlexNegative": true, "msFlexOrder": true, "msFlexPositive": true, "msFlexShrink": true, "msGridColumn": true, "msGridColumnSpan": true, "msGridRow": true, "msGridRowSpan": true, "WebkitAnimationIterationCount": true, "WebkitBoxFlex": true, "WebKitBoxFlexGroup": true, "WebkitBoxOrdinalGroup": true, "WebkitColumnCount": true, "WebkitColumns": true, "WebkitFlex": true, "WebkitFlexGrow": true, "WebkitFlexPositive": true, "WebkitFlexShrink": true, "WebkitLineClamp": true};
// Preact compat/src/util.js numeric style classification, under the notice below.
const PREACT_UNITLESS = "/^(-|f[lo].*[^se]$|g.{5,}[^ps]$|z|o[pr]|(W.{5})?[lL]i.*(t|mp)$|an|(bo|s).{4}Im|sca|m.{6}[ds]|ta|c.*[st]$|wido|ini|asp|fill|st)/";

const PREACT_NOTICE = "/*! Numeric style classification from Preact compat/src/util.js.\nThe MIT License (MIT)\n\nCopyright (c) 2015-present Jason Miller\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n*/\n";

function styleNumberSource(target: "react" | "preact" | "vue" | "svelte"): string {
  if (target === "react") return `const STYLE_UNITLESS = ${JSON.stringify(REACT_UNITLESS)};\nconst styleUnitless = (name) => Object.hasOwn(STYLE_UNITLESS, name);`;
  if (target === "preact") return `${PREACT_NOTICE}const STYLE_UNITLESS = ${PREACT_UNITLESS};\nconst styleUnitless = (name, value) => value.constructor !== Object || STYLE_UNITLESS.test(name);`;
  return "const styleUnitless = undefined;";
}

const STYLE_INPUT_SOURCE = `function cssPropertyName(name) {
  if (name === 'cssFloat') return 'float';
  return name.startsWith('--') ? name : name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()).replace(/^ms-/, '-ms-');
}
function styleInputText(value, createStyle, unitless) {
  if (value == null) return '';
  if (typeof value !== 'object' || Array.isArray(value)) return String(value);
  const style = createStyle();
  for (const [key, input] of Object.entries(value)) {
    const name = cssPropertyName(key);
    if (input == null) { style.removeProperty(name); continue; }
    let text = String(input);
    if (unitless !== undefined && typeof input === 'number' && input !== 0 && !name.startsWith('--') && !unitless(key, value)) text += 'px';
    const important = /\\s*!important\\s*$/i.test(text);
    style.setProperty(name, important ? text.replace(/\\s*!important\\s*$/i, '') : text, important ? 'important' : '');
  }
  return style.cssText;
}`;

const STYLE_TEXT_SOURCE = `export function styleText(base, decorations, previous) {
  const style = document.createElement('span').style;
  style.cssText = styleInputText(base, createStyle, styleUnitless);
  for (const [index, decoration] of decorations.entries()) {
    if (decoration.kind !== 'style' && !(decoration.kind === 'attribute' && decoration.name === 'style')) continue;
    let value = decoration.read();
    if (value === Symbol.for('html-next.invalid-result')) value = previous !== undefined && index in previous ? previous[index] : decoration.fallback ?? value;
    if (value !== Symbol.for('html-next.invalid-result') && value !== Symbol.for('html-next.no-attribute') && previous !== undefined) previous[index] = value;
    if (value === Symbol.for('html-next.invalid-result') || value === Symbol.for('html-next.no-attribute')) continue;
    if (decoration.kind === 'attribute') style.cssText = styleInputText(value, createStyle, styleUnitless);
    else style.setProperty(decoration.name, value == null ? '' : String(value));
  }
  return style.cssText;
}`;

/** Standard browser mapping keeps the server CSSOM dependency out of client compilation. */
export function inlineStyleArtifacts(target: "svelte" | "react" | "preact" | "vue" | "angular", version: string): readonly GeneratedArtifact[] {
  const header = `// Generated by HTML Next ${version}. Do not edit.\n`;
  if (target === "angular") return Object.freeze([{ path: "angular/style.ts", content: header
    + 'import { Pipe, inject } from "@angular/core";\nimport { DOCUMENT } from "@angular/common";\n'
    + "interface Decoration { readonly kind: 'class' | 'style' | 'attribute'; readonly name: string; readonly read: () => unknown; readonly fallback?: string }\n"
    + STYLE_INPUT_SOURCE.replace("cssPropertyName(name)", "cssPropertyName(name: string)").replace("styleInputText(value, createStyle, unitless)", "styleInputText(value: unknown, createStyle: () => CSSStyleDeclaration, unitless: ((name: string, value: object) => boolean) | undefined)")
    + STYLE_TEXT_SOURCE.replace("  const style = document.createElement('span').style;", "  const createStyle = () => document.createElement('span').style; const styleUnitless = undefined; const style = createStyle();").replace("styleText(base, decorations, previous)", "styleText(base: string, decorations: readonly Decoration[], document: Document, previous?: unknown[]): string")
    + `\n@Pipe({ name: "hnNextStyle", standalone: true, pure: false })
export class HtmlNextStyle {
  private readonly document = inject(DOCUMENT);
  private readonly previous: unknown[] = [];
  transform(writes: readonly Decoration[], attributes?: Record<string, unknown>): any {
    const style = styleText("", writes, this.document, this.previous);
    return attributes === undefined ? style : { ...attributes, style };
  }
}\n` }]);
  return Object.freeze([
    Object.freeze({ path: `${target}/style/package.json`, content: JSON.stringify({
      type: "module", license: "MIT", sideEffects: false, browser: { "./style.js": "./style.browser.js" },
    }, null, 2) + "\n" }),
    Object.freeze({ path: `${target}/style/style.d.ts`, content: header + `interface Decoration { readonly kind: 'class' | 'style' | 'attribute'; readonly name: string; readonly read: () => unknown; readonly fallback?: string }
export declare function styleText(base: string, decorations: readonly Decoration[], previous?: unknown[]): string;
export declare function styleObject(value: unknown): Record<string, string | number>;
export declare function styleBinding<TStyle, TElement extends Element, TResult>(value: TStyle, ref?: (element: TElement | null) => TResult): { style: TStyle; ref: (element: TElement | null) => TResult | undefined };
export declare function applyStylePriority(element: Element | null, value: unknown): void;
` }),
    Object.freeze({ path: `${target}/style/style.browser.js`, content: header + `function createStyle() { return document.createElement('span').style; }

const NORMALIZE_STYLE_NUMBERS = ${target === "preact"};
${styleNumberSource(target)}
${STYLE_OBJECT_SOURCE}
${STYLE_INPUT_SOURCE}
${STYLE_TEXT_SOURCE}
` }),
    Object.freeze({ path: `${target}/style/style.js`, content: header + `import { CSSStyleDeclaration, parsePropertyValue } from 'cssstyle';
import parse from 'css-tree/parser';
function createStyle() {
  const style = new CSSStyleDeclaration();
  const setProperty = style.setProperty;
  // cssstyle 6.2 drops a validated single-number ratio. See jsdom/jsdom#4150.
  style.setProperty = function(name, value, priority) {
    if (name.toLowerCase() === 'aspect-ratio') {
      const parsed = parsePropertyValue('aspect-ratio', value);
      if (Array.isArray(parsed) && parsed.length === 1 && parsed[0].type === 'Number') value = parsed[0].value + ' / 1';
    }
    return setProperty.call(this, name, value, priority);
  };
  return style;
}

const NORMALIZE_STYLE_NUMBERS = ${target === "preact"};
${styleNumberSource(target)}
${STYLE_OBJECT_SOURCE}
${STYLE_INPUT_SOURCE}
export function styleText(base, decorations, previous) {
  const style = createStyle();
  const emptyCustom = new Map();
  const replace = (value) => {
  style.cssText = '';
  emptyCustom.clear();
  const declarations = parse(value, { context: 'declarationList', parseValue: false });
  // Literal declarations cascade; the bindings below replace the previous priority.
  for (const declaration of declarations.children) {
    if (declaration.type !== 'Declaration' || declaration.value.type !== 'Raw') continue;
    const priority = declaration.important ? 'important' : '';
    const name = declaration.property;
    const custom = name.startsWith('--');
    const empty = declaration.value.value.trim() === '';
    if (empty && !custom) continue;
    if (custom && priority === '' && (emptyCustom.get(name) ?? style.getPropertyPriority(name)) === 'important') continue;
    if (empty) {
      // Public setProperty removes empty values; CSS literals can declare an empty custom property.
      style.removeProperty(name);
      emptyCustom.set(name, priority);
      continue;
    }
    if (custom) emptyCustom.delete(name);
    const important = priority === '' ? Array.from({ length: style.length }, (_, index) => style.item(index))
      .filter((name) => style.getPropertyPriority(name) === 'important')
      .map((name) => [name, style.getPropertyValue(name)]) : [];
    style.setProperty(declaration.property, declaration.value.value, priority);
    for (const [name, value] of important) style.setProperty(name, value, 'important');
  }
  };
  replace(styleInputText(base, createStyle, styleUnitless));
  for (const [index, decoration] of decorations.entries()) {
    if (decoration.kind === 'attribute' && decoration.name === 'style') {
      let value = decoration.read();
    if (value === Symbol.for('html-next.invalid-result')) value = previous !== undefined && index in previous ? previous[index] : decoration.fallback ?? value;
    if (value !== Symbol.for('html-next.invalid-result') && value !== Symbol.for('html-next.no-attribute') && previous !== undefined) previous[index] = value;
      if (value !== Symbol.for('html-next.invalid-result') && value !== Symbol.for('html-next.no-attribute')) replace(styleInputText(value, createStyle, styleUnitless));
      continue;
    }
    if (decoration.kind !== 'style') continue;
    let value = decoration.read();
    if (value === Symbol.for('html-next.invalid-result')) value = previous !== undefined && index in previous ? previous[index] : decoration.fallback ?? value;
    if (value !== Symbol.for('html-next.invalid-result') && value !== Symbol.for('html-next.no-attribute') && previous !== undefined) previous[index] = value;
    if (value === Symbol.for('html-next.invalid-result')) continue;
    emptyCustom.delete(decoration.name);
    style.setProperty(decoration.name, value == null ? '' : String(value));
  }
  return [style.cssText, ...[...emptyCustom].map(([name, priority]) => name + ': ' + (priority === 'important' ? '!important' : '') + ';')].filter(Boolean).join(' ');
}
` }),
  ]);
}
