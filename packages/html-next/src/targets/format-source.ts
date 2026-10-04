import ts from "typescript-compiler";
import { createFormatValue } from "../format.js";

/**
 * Serialize the shared, closure-free factory with contextual types restored after transpilation.
 * Retain its actual parameter names so bundler renaming cannot change the generated behavior.
 * esbuild/tsx's keep-names helper affects only debugging names; a local identity supplies it.
 */
export function formattingHelperSource(binding = "formatValue"): string {
  const source = createFormatValue.toString();
  const parsed = ts.createSourceFile("format.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(source.match(/\b__name\d*\b/g) ?? []);
  const transformed = ts.transform(parsed, [(context) => {
    const visit: ts.Visitor = (node) => {
      if (ts.isParameter(node) && node.type === undefined) {
        return context.factory.updateParameterDeclaration(node, node.modifiers, node.dotDotDotToken, node.name,
          node.questionToken, node.dotDotDotToken === undefined ? context.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
            : context.factory.createArrayTypeNode(context.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)), node.initializer);
      }
      if (ts.isFunctionDeclaration(node) && node.parent === parsed) {
        const declarations = [...names].flatMap((name) => ts.createSourceFile("name.ts", `const ${name} = (fn: any, ..._names: any[]): any => fn;`, ts.ScriptTarget.Latest, true).statements);
        const body = ts.visitEachChild(node.body!, visit, context);
        return context.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken,
          context.factory.createIdentifier("createFormatValue"), node.typeParameters,
          node.parameters.map((parameter) => ts.visitNode(parameter, visit) as ts.ParameterDeclaration),
          context.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
          context.factory.updateBlock(body, [...declarations, ...body.statements]));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (file) => ts.visitNode(file, visit) as ts.SourceFile;
  }]);
  try { return `${ts.createPrinter().printFile(transformed.transformed[0]!)}\nconst ${binding} = createFormatValue();\n`; }
  finally { transformed.dispose(); }
}
