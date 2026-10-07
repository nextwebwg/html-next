import type { ExpressionNode } from "./expression.js";

/** Finds an outer root compared with this loop's key; complex expressions keep ordinary tracking. */
export function keyedEquality(expression: ExpressionNode, key: ExpressionNode, alias: string): string | undefined {
  if (expression.kind !== "binary" || expression.op !== "=" && expression.op !== "!=") return undefined;
  let base = key;
  while (base.kind === "member") base = base.object;
  if (base.kind !== "id" || base.name !== alias) return undefined;
  const same = (left: ExpressionNode, right: ExpressionNode): boolean => {
    while (left.kind === "member" && right.kind === "member") {
      if (left.key !== right.key) return false;
      left = left.object;
      right = right.object;
    }
    return left.kind === "id" && right.kind === "id" && left.name === right.name;
  };
  for (const [item, root] of [[expression.left, expression.right], [expression.right, expression.left]] as const) {
    if (root.kind === "id" && root.name !== alias && root.name !== "loop" && same(item, key)) return root.name;
  }
  return undefined;
}

/** Visits the affected entries once. Lookup uses SameValueZero; bindings retain strict equality. */
export function visitSelected<T>(index: ReadonlyMap<unknown, T>, before: unknown, after: unknown, visit: (entry: T, changed: number) => void, changed = 0): void {
  if (before === after) return;
  const previous = index.get(before);
  const next = index.get(after);
  if (previous !== undefined) visit(previous, changed);
  if (next !== undefined && next !== previous) visit(next, changed);
}
