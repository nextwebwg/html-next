import {
  buildComponentGraph as buildParsedComponentGraph,
  type BuildGraphOptions,
  type ComponentGraph,
} from "./graph.js";
import { parseComponentResource, parseComponentResourceForCheck } from "./source-parser.js";

export { parseComponentResource } from "./source-parser.js";

export function buildComponentGraph(
  rootSpecifiers: readonly string[],
  options: Omit<BuildGraphOptions, "parseComponentResource">,
): Promise<ComponentGraph> {
  return buildParsedComponentGraph(rootSpecifiers, { ...options, parseComponentResource: options.collectDiagnostics ? parseComponentResourceForCheck : parseComponentResource });
}
