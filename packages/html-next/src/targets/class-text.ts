export const CLASS_TEXT_SOURCE = `function classText(base: string | undefined, decorations: readonly { readonly kind: 'class' | 'style'; readonly name: string; readonly read: () => unknown }[]): string | undefined {
  const tokens = new Set((base ?? '').split(/[ \\t\\r\\n\\f]+/).filter(Boolean));
  let value = base;
  for (const decoration of decorations) {
    if (decoration.kind !== 'class') continue;
    const candidate = decoration.read();
    if (candidate === Symbol.for('html-next.invalid-result') || Boolean(candidate) === tokens.has(decoration.name)) continue;
    if (candidate) tokens.add(decoration.name); else tokens.delete(decoration.name);
    value = [...tokens].join(' ');
  }
  return value;
}`;
