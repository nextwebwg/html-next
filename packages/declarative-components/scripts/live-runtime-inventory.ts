export const liveRuntimeSubsystemModules = {
  parsingAndContract: [
    "packages/declarative-components/src/browser-source.ts",
    "packages/declarative-components/src/contract.ts",
    "packages/declarative-components/src/diagnostics.ts",
    "packages/declarative-components/src/language.ts",
    "packages/declarative-components/src/names.ts",
    "packages/declarative-components/src/parser.ts",
  ],
  discoveryAndLifecycle: [
    "packages/declarative-components/src/browser.ts",
    "packages/declarative-components/src/browser-loader.ts",
    "packages/declarative-components/src/registry.ts",
  ],
  reactiveExecution: [
    "packages/declarative-components/src/controller.ts",
    "packages/declarative-components/src/data.ts",
    "packages/declarative-components/src/expression.ts",
    "packages/declarative-components/src/reactivity.ts",
    "packages/declarative-components/src/runtime.ts",
  ],
  typesAndValidation: [
    "packages/declarative-components/src/freeze.ts",
    "packages/declarative-components/src/json-schema.ts",
    "packages/declarative-components/src/type-system.ts",
    "packages/declarative-components/src/validate.ts",
    "packages/declarative-components/src/validity-css.ts",
    "packages/declarative-components/src/validity.ts",
  ],
  styleAndContentPolicy: [
    "packages/declarative-components/src/sanitize.ts",
    "packages/declarative-components/src/style.ts",
  ],
  componentResources: [
    "packages/declarative-components/src/graph.ts",
    "packages/declarative-components/src/resolve.ts",
  ],
  formEnhancement: [
    "packages/html-forms/src/index.ts",
  ],
} as const;

export interface LiveRuntimeInventory {
  readonly subsystemBytes: Readonly<Record<string, number>>;
  readonly unclassifiedModules: readonly string[];
}

const moduleSubsystem = new Map<string, string>();
for (const [subsystem, paths] of Object.entries(liveRuntimeSubsystemModules)) {
  for (const path of paths) {
    if (moduleSubsystem.has(path)) {
      throw new Error(`The live runtime module ${path} belongs to more than one subsystem.`);
    }
    moduleSubsystem.set(path, subsystem);
  }
}

export function classifyLiveRuntimeModules(
  moduleBytes: Readonly<Record<string, number>>,
): LiveRuntimeInventory {
  const subsystemBytes: Record<string, number> = Object.fromEntries(
    Object.keys(liveRuntimeSubsystemModules).map((subsystem) => [subsystem, 0]),
  );
  const unclassifiedModules: string[] = [];

  for (const [path, bytes] of Object.entries(moduleBytes)) {
    const subsystem = moduleSubsystem.get(path);
    if (subsystem === undefined) {
      unclassifiedModules.push(path);
    } else {
      subsystemBytes[subsystem] = (subsystemBytes[subsystem] ?? 0) + bytes;
    }
  }

  return {
    subsystemBytes,
    unclassifiedModules: unclassifiedModules.sort(),
  };
}
