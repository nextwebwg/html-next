import type { ExpressionNode } from "../expression.js";
import { Lowering, mayProduceInvalidResult, typeOf, type Scope } from "./vue-lowering.js";

/** Keep JavaScript lookup semantics while allowing HTML Next's absent keys in strict TSX. */
export class TypeScriptLowering extends Lowering {
  override value(node: ExpressionNode, scope: Scope): string {
    if (node.kind !== "index") return super.value(node, scope);
    const object = this.value(node.object, scope);
    const typed = typeOf(node.object, scope);
    const target = typed.type.kind === "object" ? `(${object} as Record<string, any>)` : `(${object})`;
    const index = this.value(node.index, scope);
    if (mayProduceInvalidResult(node.object, scope) || mayProduceInvalidResult(node.index, scope)) {
      return `((objectValue: any, indexValue: any) => objectValue === Symbol.for("html-next.invalid-result") || indexValue === Symbol.for("html-next.invalid-result") ? Symbol.for("html-next.invalid-result") : objectValue${typed.nullable ? "?." : ""}[indexValue])(${object}, ${index})`;
    }
    return `${target}${typed.nullable ? "?." : ""}[${index} as any]`;
  }
}

