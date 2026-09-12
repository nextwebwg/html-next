export interface PackageComponentInput {
  readonly source: string;
}

export interface PackagePassThrough {
  readonly source: string;
  readonly target: string;
  /** Follow and copy relative ESM dependencies without importing the module. */
  readonly module?: boolean;
}

export interface ComponentPackageConfig {
  readonly name: string;
  readonly version: string;
  readonly outDirectory: string;
  readonly components: readonly PackageComponentInput[];
  readonly passThrough?: readonly PackagePassThrough[];
  readonly exports?: Readonly<Record<string, unknown>>;
}
