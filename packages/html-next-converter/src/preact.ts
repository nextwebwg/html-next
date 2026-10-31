import ts from "typescript";
import type { GeneratedArtifact } from "@nextwebwg/html-next";

/** Share the React lowering while binding generated code and types to Preact's compatibility API. */
export function preactArtifact(artifact: GeneratedArtifact): GeneratedArtifact {
  const path = artifact.path.replace(/^react\//, "preact/");
  if (!/\.tsx?$/.test(path)) return { ...artifact, path };
  let content = artifact.content.replace(" for React 19. Do not edit.", " for Preact 11. Do not edit.");
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements.toReversed()) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "react") continue;
    content = content.slice(0, statement.moduleSpecifier.getStart(source)) + '"preact/compat"' + content.slice(statement.moduleSpecifier.end);
  }
  if (path.endsWith(".tsx")) content = `/** @jsxImportSource preact */\n${content}`;
  return { path, content };
}
