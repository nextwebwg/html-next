import type { TypeNode } from "./type-system.js";

/** Static type shared by the interpreter's aliases and every target's expression lowering. */
export const INPUT_FAILURE_TYPE: TypeNode = { kind: "object", open: false, fields: [
  { name: "name", optional: false, type: { kind: "terminal", name: "string" } },
  { name: "message", optional: false, type: { kind: "terminal", name: "string" } },
] };

export const INPUT_STATUS_TYPE: TypeNode = {
  kind: "object", open: false, fields: [
    { name: "ready", optional: false, type: { kind: "terminal", name: "boolean" } },
    { name: "pending", optional: false, type: { kind: "terminal", name: "boolean" } },
    { name: "stale", optional: false, type: { kind: "terminal", name: "boolean" } },
    { name: "error", optional: false, type: { kind: "union", members: [
      { kind: "terminal", name: "null" },
      INPUT_FAILURE_TYPE,
    ] } },
  ],
};


export { publicInputStatus, READY_INPUT, UNRESOLVED_INPUT, readInputStatus, type InputStatus, type InputFailure } from "./inputs.js";
