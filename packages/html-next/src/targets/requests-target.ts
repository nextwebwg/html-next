import type { TargetRequest } from "./backend.js";
import { quote } from "./shared.js";

/** The request helper's exports a converted component imports, and its types. */
export const REQUEST_HELPERS = ["frameworkRequest", "propResponder"] as const;
export const REQUEST_TYPES = ["RequestEvent", "Responder"] as const;

/** A request's function prop type: it answers with the answer, `null`, or a promise of either. */
export function responderType(request: TargetRequest): string {
  return `Responder<${request.detailType}, ${request.answerType}>`;
}

/** A request's event form: a listener that receives the request event. */
export function requestListenerType(request: TargetRequest): string {
  return `(event: RequestEvent<${request.detailType}, ${request.answerType}>) => void`;
}

/** The typed-value check, from the converted props helper, that request details and answers use. */
export const REQUEST_CHECK = "acceptsDeclaredEvent";

/**
 * `host.request` for the component: each declared request's detail and answer checks, the nested
 * type and constraint checks a declared event's detail uses, warning with the component's
 * definition URL as the live runtime does.
 */
export function frameworkRequestSource(requests: readonly TargetRequest[], definition: string): string {
  const check = (type: TargetRequest["contract"]["type"]): string => `(value: unknown): boolean => ${REQUEST_CHECK}(value, ${JSON.stringify(type)})`;
  return `frameworkRequest(${quote(definition)}, { ${requests.map((request) =>
    `${quote(request.name)}: [${check(request.contract.type)}, ${check(request.contract.returns)}]`,
  ).join(", ")} })`;
}

/** Each request's responder, read from the component's props when the request arrives. */
export function respondersSource(requests: readonly TargetRequest[], read: (name: string) => string, listener: (request: TargetRequest) => string): string {
  return `{ ${requests.map((request) => `${quote(request.name)}: () => propResponder(${read(request.propName)}, ${listener(request)})`).join(", ")} }`;
}
