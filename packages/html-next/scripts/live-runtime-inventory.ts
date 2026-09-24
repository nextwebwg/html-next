export const liveRuntimeSubsystemModules = {
  parsingAndContract: [
    "packages/html-next/src/browser-source.ts",
    "packages/html-next/src/contract.ts",
    "packages/html-next/src/diagnostics.ts",
    "packages/html-next/src/language.ts",
    "packages/html-next/src/names.ts",
    "packages/html-next/src/parser.ts",
  ],
  discoveryAndLifecycle: [
    "packages/html-next/src/browser.ts",
    "packages/html-next/src/browser-loader.ts",
    "packages/html-next/src/registry.ts",
  ],
  reactiveExecution: [
    "packages/html-next/src/controller.ts",
    "packages/html-next/src/data.ts",
    "packages/html-next/src/duration.ts",
    "packages/html-next/src/expression.ts",
    "packages/html-next/src/reactivity.ts",
    "packages/html-next/src/runtime.ts",
  ],
  typesAndValidation: [
    "packages/html-next/src/freeze.ts",
    "packages/html-next/src/type-system.ts",
    "packages/html-next/src/validate.ts",
    "packages/html-next/src/validity-css.ts",
    "packages/html-next/src/validity.ts",
  ],
  styleAndContentPolicy: [
    "packages/html-next/src/component-styles.ts",
    "packages/html-next/src/sanitize.ts",
  ],
  componentResources: [
    "packages/html-next/src/graph.ts",
    "packages/html-next/src/resolve.ts",
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
