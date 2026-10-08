export interface DiagnosticLocation {
  /** One-based authored source coordinates. */
  readonly line: number;
  readonly column: number;
}

export interface HtmlDiagnostic extends Partial<DiagnosticLocation> {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
  /** Omitted means error. A warning never withholds a definition or fails a check. */
  readonly severity?: "error" | "warning";
}

// Keep build-time provenance out of the normalized AST and generated runtime data.
const locations = new WeakMap<object, DiagnosticLocation>();

export function getDiagnosticLocation(node: object): DiagnosticLocation | undefined {
  return locations.get(node);
}

export function withDiagnosticLocation<T>(location: DiagnosticLocation | undefined, read: () => T): T {
  if (location === undefined) return read();
  try {
    const result = read();
    if (result !== null && typeof result === "object") locations.set(result, location);
    return result;
  } catch (error) {
    if (error instanceof HtmlDiagnosticError && error.diagnostic.line === undefined) {
      throw new HtmlDiagnosticError({ ...error.diagnostic, ...location });
    }
    throw error;
  }
}

export class HtmlDiagnosticError extends Error {
  readonly diagnostic: HtmlDiagnostic;

  constructor(diagnostic: HtmlDiagnostic) {
    const location = diagnostic.source ? `${diagnostic.source}: ` : "";
    super(`${location}${diagnostic.code}: ${diagnostic.message}`);
    this.name = "HtmlDiagnosticError";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

export class HtmlDiagnosticAggregateError extends Error {
  readonly diagnostics: readonly HtmlDiagnostic[];

  constructor(diagnostics: readonly HtmlDiagnostic[]) {
    super(diagnostics.map((diagnostic) => new HtmlDiagnosticError(diagnostic).message).join("\n"));
    this.name = "HtmlDiagnosticAggregateError";
    this.diagnostics = Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));
  }
}

/** Recover only compiler failures; implementation and operational errors still propagate. */
export function recoverDiagnostic(error: unknown, report?: (diagnostic: HtmlDiagnostic) => void): void {
  if (report !== undefined && error instanceof HtmlDiagnosticError) report(error.diagnostic);
  else if (report !== undefined && error instanceof HtmlDiagnosticAggregateError) {
    for (const diagnostic of error.diagnostics) report(diagnostic);
  } else throw error;
}

export function fail(
  code: string,
  message: string,
  source?: string,
  location?: DiagnosticLocation,
): never {
  throw new HtmlDiagnosticError(
    { code, message, ...(source === undefined ? {} : { source }), ...location },
  );
}
