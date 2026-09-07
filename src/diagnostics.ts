export interface HtmlDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
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

export function fail(
  code: string,
  message: string,
  source?: string,
): never {
  throw new HtmlDiagnosticError(
    source === undefined ? { code, message } : { code, message, source },
  );
}

