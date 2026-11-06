import { formatType, typeAtKey, type TypeNode } from "../type-system.js";

/** Immutable metadata emitted by both DOM and framework expression compilers. */
export class ReferenceSchemas {
  readonly sources: string[] = [];
  private readonly schemas = new Map<string, string>();

  constructor(private readonly check: (type: TypeNode) => string, readonly prefix: string) {}

  reference(type: TypeNode | undefined, depth: number): string {
    if (type === undefined) return "0";
    const keys = new Set<string>();
    const collect = (type: TypeNode): void => {
      if (type.kind === "object") for (const field of type.fields) keys.add(field.name);
      else if (type.kind === "union") type.members.forEach(collect);
      else if (type.kind === "selected") type.options.forEach(option => collect(option.type));
      else if (type.kind === "constrained") collect(type.base);
    };
    if (depth > 0) collect(type);
    const fields = [...keys].map(key => `[${JSON.stringify(key)}]: ${this.reference(typeAtKey(type, key), depth - 1)}`);
    let numeric = "0", other = "0";
    if (depth > 0) {
      let index = 0;
      while (keys.has(String(index))) index += 1;
      let name = "_";
      while (keys.has(name)) name += "_";
      numeric = this.reference(typeAtKey(type, String(index)), depth - 1);
      other = this.reference(typeAtKey(type, name), depth - 1);
    }
    // Only the final value is checked. Intermediate schemas carry child choices, and never
    // duplicate a container's full type label or retain descendants this reference cannot reach.
    if (depth > 0 && fields.length === 0 && numeric === "0" && other === "0") return "0";
    const source = depth === 0 ? `[${this.check(type)}, ${JSON.stringify(formatType(type))}]`
      : `[0, "", { ${fields.join(", ")} }, ${numeric}, ${other}]`;
    const known = this.schemas.get(source);
    if (known !== undefined) return known;
    const result = `${this.prefix}${this.sources.length}`;
    this.sources.push(source);
    this.schemas.set(source, result);
    return result;
  }
}
