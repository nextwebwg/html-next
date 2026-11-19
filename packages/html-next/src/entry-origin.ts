import type { ExpressionNode } from "./expression.js";
import type { ComponentDeclaration, ReactiveDeclaration, SlotNode } from "./template.js";
import type { ComponentContract } from "./types.js";

/** Identity provenance, independent of the value's declared shape. A new record is never an entry. */
export interface EntryOrigin {
  readonly kind: "entry" | "list" | "null";
  readonly lists: readonly string[];
}
const absent: EntryOrigin = { kind: "null", lists: [] };

function merge(origins: readonly (EntryOrigin | undefined)[]): EntryOrigin | undefined {
  if (origins.some(origin => origin === undefined)) return undefined;
  const present = (origins as EntryOrigin[]).filter(origin => origin.kind !== "null");
  const kind = present[0]?.kind;
  if (kind === undefined) return absent;
  if (present.some(origin => origin.kind !== kind)) return undefined;
  return { kind, lists: [...new Set(present.flatMap(origin => origin.lists))] };
}

/** Follow expressions which preserve entry identity, including containers of those same entries. */
export function entryOrigin(node: ExpressionNode, bindings: ReadonlyMap<string, EntryOrigin | undefined>): EntryOrigin | undefined {
  switch (node.kind) {
    case "literal": return node.value == null ? absent : undefined;
    case "id": return bindings.get(node.name);
    case "index": {
      const origin = entryOrigin(node.object, bindings);
      return origin?.kind === "list" ? { kind: "entry", lists: origin.lists } : undefined;
    }
    case "conditional":
      if (node.test.kind === "literal" && typeof node.test.value === "boolean") return entryOrigin(node.test.value ? node.consequent : node.alternate, bindings);
      return merge([entryOrigin(node.consequent, bindings), entryOrigin(node.alternate, bindings)]);
    case "call": return node.fn === "default" ? merge(node.args.map(arg => entryOrigin(arg, bindings))) : undefined;
    case "array": {
      const origin = merge(node.items.map(item => entryOrigin(item, bindings)));
      return origin !== undefined && origin.kind !== "list" ? { kind: "list", lists: origin.lists } : undefined;
    }
    default: return undefined;
  }
}

export function componentEntryOrigins(contract: ComponentContract, declarations: readonly ComponentDeclaration[]): ReadonlyMap<string, EntryOrigin | undefined> {
  const bindings = new Map<string, EntryOrigin | undefined>();
  for (const slot of Object.values(contract.slots ?? {})) if (slot.as !== undefined) bindings.set(slot.as, { kind: "list", lists: [slot.as] });
  const computed = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "computed");
  // Null is the initial empty provenance for a cycle. Propagate until every path has been visited;
  // a foreign source poisons its dependants, while recursive aliases can keep a proven own source.
  for (const declaration of computed) bindings.set(declaration.name, absent);
  for (let pass = 0; pass <= computed.length; pass++) {
    let changed = false;
    for (const declaration of computed) {
      const origin = declaration.expression === undefined ? undefined : entryOrigin(declaration.expression.ast, bindings);
      const previous = bindings.get(declaration.name);
      if (origin?.kind === previous?.kind && (origin === undefined || previous !== undefined && origin.lists.length === previous.lists.length && origin.lists.every(list => previous.lists.includes(list)))) continue;
      bindings.set(declaration.name, origin);
      changed = true;
    }
    if (!changed) break;
  }
  return bindings;
}

/** One-source plans retain their existing public representation. */
export function entryLists(of: NonNullable<SlotNode["of"]>): readonly string[] {
  return of.lists ?? [of.list];
}

export function entryTags(contract: ComponentContract, of: NonNullable<SlotNode["of"]>): readonly string[] {
  const lists = entryLists(of);
  return [...new Set(Object.values(contract.slots ?? {}).flatMap(slot => slot.as !== undefined && lists.includes(slot.as) ? slot.accepts ?? [] : []))];
}

/** Find the index in its owning list, including when an expression can select several own lists. */
export function ownedEntryIndex(value: unknown, list: unknown): number {
  if (value === null || typeof value !== "object" || !Array.isArray(list)) return -1;
  const direct = list.indexOf(value);
  if (direct >= 0) return direct;
  for (const candidate of list) if (Array.isArray(candidate)) {
    const index = candidate.indexOf(value);
    if (index >= 0) return index;
  }
  return -1;
}
