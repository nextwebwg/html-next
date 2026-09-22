import { defineContractWithNativeCheck } from "./contract.js";
import { getDomInterface } from "./platform.js";
import type { ComponentContract, DefineContractOptions } from "./types.js";

export { serializePropTarget } from "./contract.js";

/** Defines a contract using the build-time DOM interface inventory. */
export function defineContract(
  input: unknown,
  options: DefineContractOptions = {},
): ComponentContract {
  return defineContractWithNativeCheck(input, options, (name) => getDomInterface(name) !== undefined);
}
