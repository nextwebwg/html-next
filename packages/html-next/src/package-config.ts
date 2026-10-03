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
  /** Publish HTML definitions and controllers for consumer-side framework conversion. */
  readonly sourceOnly?: boolean;
  readonly components: readonly PackageComponentInput[];
  readonly passThrough?: readonly PackagePassThrough[];
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}
