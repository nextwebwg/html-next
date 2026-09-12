import { validateJsonSchema, type JsonSchema } from "./json-schema.js";
import {
  parseTypedValue,
  parseTypeExpression,
  type TypeInput,
  type TypeIssue,
} from "./type-system.js";

export interface DataState<T = unknown> {
  readonly pending: boolean;
  readonly value: T | null;
  readonly error: unknown | null;
  readonly ok: boolean;
}

export interface DataRequestOptions<T = unknown> {
  readonly source: string;
  readonly baseURL: string;
  readonly type?: string;
  /** Inline parsed type/schema for the decoded response value. */
  readonly schema?: TypeInput | string;
  /** Resolved external JSON Schema URL. */
  readonly schemaURL?: string;
  readonly debounce?: number;
  readonly poll?: number;
  readonly fetch?: typeof fetch;
  readonly setTimer?: (callback: () => void, delay: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly validate?: (value: unknown) => T;
  readonly onState: (state: DataState<T>) => void;
}

export class DataValidationError extends TypeError {
  constructor(readonly issues: readonly TypeIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "DataValidationError";
  }
}

function requestURL(source: string, baseURL: string, parameters: Readonly<Record<string, unknown>>): string {
  const used = new Set<string>();
  const expanded = source.replace(/\{([A-Za-z_$][A-Za-z0-9_$-]*)\}/g, (_match, name: string) => {
    used.add(name);
    const value = parameters[name];
    return value == null ? "" : encodeURIComponent(String(value));
  });
  const url = new URL(expanded, baseURL);
  for (const [name, value] of Object.entries(parameters)) {
    if (used.has(name) || value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(name, String(item));
    } else {
      url.searchParams.set(name, String(value));
    }
  }
  return url.href;
}

/** An owned, abortable declared read with injectable network and clock boundaries. */
export class DataResource<T = unknown> {
  readonly #fetch: typeof fetch;
  readonly #setTimer: (callback: () => void, delay: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #parameters: Readonly<Record<string, unknown>> = {};
  #abort: AbortController | undefined;
  #timer?: unknown;
  #loadedSchema: JsonSchema | undefined;
  #generation = 0;
  #connected = false;

  constructor(readonly options: DataRequestOptions<T>) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  update(parameters: Readonly<Record<string, unknown>>): void {
    this.#parameters = { ...parameters };
    this.#connected = true;
    this.#cancel();
    const generation = ++this.#generation;
    const run = (): void => { void this.#request(generation); };
    if ((this.options.debounce ?? 0) > 0) {
      this.#timer = this.#setTimer(run, this.options.debounce!);
    } else {
      run();
    }
  }

  disconnect(): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#generation += 1;
    this.#cancel();
  }

  #cancel(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }

  async #request(generation: number): Promise<void> {
    if (!this.#connected || generation !== this.#generation) return;
    const abort = new AbortController();
    this.#abort = abort;
    const previous = this.options;
    previous.onState({ pending: true, value: null, error: null, ok: false });
    try {
      const response = await this.#fetch(
        requestURL(previous.source, previous.baseURL, this.#parameters),
        { signal: abort.signal },
      );
      if (!response.ok) throw new TypeError(`Request failed with ${response.status}.`);
      const externalSchema = previous.schemaURL === undefined
        ? undefined
        : this.#loadedSchema ?? await this.#loadSchema(previous.schemaURL, abort.signal);
      const raw = previous.type === "text" ? await response.text() : await response.json();
      let value: T;
      if (previous.validate !== undefined) {
        value = previous.validate(raw);
      } else if (previous.schema !== undefined) {
        const schema = typeof previous.schema === "string"
          ? parseTypeExpression(previous.schema)
          : previous.schema;
        const parsed = parseTypedValue(raw, schema);
        if (!parsed.ok) throw new DataValidationError(parsed.issues);
        value = parsed.value as T;
      } else if (externalSchema !== undefined) {
        const issues = validateJsonSchema(raw, externalSchema);
        if (issues.length > 0) throw new DataValidationError(issues);
        value = raw as T;
      } else {
        value = raw as T;
      }
      if (!this.#connected || generation !== this.#generation) return;
      previous.onState({ pending: false, value, error: null, ok: true });
    } catch (error) {
      if (abort.signal.aborted || !this.#connected || generation !== this.#generation) return;
      previous.onState({ pending: false, value: null, error, ok: false });
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
      if (this.#connected && generation === this.#generation && (previous.poll ?? 0) > 0) {
        this.#timer = this.#setTimer(() => { void this.#request(generation); }, previous.poll!);
      }
    }
  }

  async #loadSchema(source: string, signal: AbortSignal): Promise<JsonSchema> {
    const response = await this.#fetch(new URL(source, this.options.baseURL), { signal });
    if (!response.ok) throw new TypeError(`Schema request failed with ${response.status}.`);
    const schema = await response.json() as unknown;
    if (typeof schema !== "boolean" && (schema === null || typeof schema !== "object" || Array.isArray(schema))) {
      throw new TypeError("A JSON Schema resource must contain a boolean or object schema.");
    }
    this.#loadedSchema = schema as JsonSchema;
    return this.#loadedSchema;
  }
}
