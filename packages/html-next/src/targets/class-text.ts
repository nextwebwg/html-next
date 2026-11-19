export const CLASS_TEXT_SOURCE = `function classText(base: string | undefined, decorations: readonly { readonly kind: 'class' | 'style' | 'attribute'; readonly name: string; readonly read: () => unknown }[], scope = ''): string | undefined {
  let tokens = new Set((base ?? '').split(/[ \\t\\r\\n\\f]+/).filter(Boolean));
  let value = base;
  for (const decoration of decorations) {
    if (decoration.kind === 'style' || decoration.kind === 'attribute' && decoration.name === 'style') continue;
    const candidate = decoration.read();
    if (candidate === Symbol.for('html-next.invalid-result') || candidate === Symbol.for('html-next.no-attribute')) continue;
    if (decoration.kind === 'attribute') {
      value = candidate == null ? undefined : String(candidate);
      tokens = new Set((value ?? '').split(/[ \\t\\r\\n\\f]+/).filter(Boolean));
      continue;
    }
    if (Boolean(candidate) === tokens.has(decoration.name)) continue;
    if (candidate) tokens.add(decoration.name); else tokens.delete(decoration.name);
    value = [...tokens].join(' ');
  }
  if (scope === '') return value;
  const missing = scope.split(/[ \\t\\r\\n\\f]+/).filter(token => token !== '' && !tokens.has(token));
  return missing.length === 0 ? value : value == null ? missing.join(' ') : value + ' ' + missing.join(' ');
}`;

export const CLASS_BINDINGS_SOURCE = `${CLASS_TEXT_SOURCE}

export interface ClassBindingInput {
  readonly base?: string;
  readonly ordered?: boolean;
  readonly scope?: string;
  readonly bindings: readonly (readonly [token: string | null, value: unknown])[];
}

export function classBindingText(input: ClassBindingInput): string | undefined {
  return classText(input.base, input.bindings.map(([name, value]) => ({ kind: name === null ? 'attribute' as const : 'class' as const, name: name ?? 'class', read: () => value })), input.scope);
}

export function initializeClassBindings(element: Element, input: ClassBindingInput): unknown[] {
  const existing = element.getAttribute('class');
  if (existing === (classBindingText(input) ?? null)) return [];
  const authored = input.scope ? input.base === undefined ? input.scope : input.scope + ' ' + input.base : input.base;
  if (authored !== undefined) element.setAttribute('class', existing == null || existing === '' ? authored : authored + ' ' + existing);
  return [];
}

export function applyClassBindings(element: Element, input: ClassBindingInput, previous: unknown[]): void {
  if (input.ordered && input.bindings.every(([, value], index) =>
    value !== Symbol.for('html-next.invalid-result') && (value === Symbol.for('html-next.no-attribute')
      ? !(index in previous) : index in previous && Object.is(value, previous[index])))) return;
  if (input.ordered) for (const [index, [token, value]] of input.bindings.entries()) {
    if (token === null && value === Symbol.for('html-next.no-attribute') && index in previous) { element.removeAttribute('class'); delete previous[index]; }
  }
  for (const [index, [token, candidate]] of input.bindings.entries()) {
    const value = candidate === Symbol.for('html-next.invalid-result') && input.ordered && index in previous ? previous[index] : candidate;
    if (value === Symbol.for('html-next.invalid-result') || value === Symbol.for('html-next.no-attribute') || !input.ordered && index in previous && Object.is(value, previous[index])) continue;
    if (token !== null) element.classList.toggle(token, Boolean(value));
    else {
      const text = input.scope ? value == null ? input.scope : String(value) + ' ' + input.scope : value == null ? null : String(value);
      if (text === null) element.removeAttribute('class'); else element.setAttribute('class', text);
    }
    previous[index] = value;
  }
}

const classBindingRefs = /* @__PURE__ */ new WeakMap<Element, { owner: object; previous: unknown[] }>();
export function applyClassBindingRef(element: Element | null, owner: object, input: ClassBindingInput): void {
  if (element === null) return;
  let state = classBindingRefs.get(element);
  if (state === undefined || state.owner !== owner) {
    state = { owner, previous: [] };
    classBindingRefs.set(element, state);
  }
  applyClassBindings(element, input, state.previous);
}`;
