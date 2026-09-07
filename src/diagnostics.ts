export interface Html7Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
}

export class Html7DiagnosticError extends Error {
  readonly diagnostic: Html7Diagnostic;

  constructor(diagnostic: Html7Diagnostic) {
    const location = diagnostic.source ? `${diagnostic.source}: ` : "";
    super(`${location}${diagnostic.code}: ${diagnostic.message}`);
    this.name = "Html7DiagnosticError";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

export function fail(
  code: string,
  message: string,
  source?: string,
): never {
  throw new Html7DiagnosticError(
    source === undefined ? { code, message } : { code, message, source },
  );
}

