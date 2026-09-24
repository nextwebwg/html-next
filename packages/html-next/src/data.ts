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
  readonly debounce?: number;
  readonly poll?: number;
  readonly fetch?: typeof fetch;
  readonly setTimer?: (callback: () => void, delay: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Optional application adapter for validation, coercion, or projection before publication. */
  readonly adapt?: (value: unknown) => T;
  readonly onState: (state: DataState<T>) => void;
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
  /** The most recent resolved value, kept so a refetch or failure does not unbind it. */
  #value: T | null = null;
  #parameters: Readonly<Record<string, unknown>> = {};
  #abort: AbortController | undefined;
  #timer?: unknown;
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

  #stale(generation: number): boolean {
    return !this.#connected || generation !== this.#generation;
  }

  async #request(generation: number): Promise<void> {
    if (this.#stale(generation)) return;
    const abort = new AbortController();
    this.#abort = abort;
    const previous = this.options;
    // The last resolved value stays bound while the next request is in flight, and through a
    // failure: a read of `.value` should not blank while `.pending` reports the reason.
    previous.onState({ pending: true, value: this.#value, error: null, ok: false });
    try {
      const response = await this.#fetch(
        requestURL(previous.source, previous.baseURL, this.#parameters),
        { signal: abort.signal },
      );
      if (!response.ok) throw new TypeError(`Request failed with ${response.status}.`);
      // A textual declared type reads the body as text; every other type is JSON.
      const textual = previous.type === "text" || previous.type === "string";
      const raw = textual ? await response.text() : await response.json();
      const value = previous.adapt === undefined ? raw as T : previous.adapt(raw);
      if (this.#stale(generation)) return;
      this.#value = value;
      previous.onState({ pending: false, value, error: null, ok: true });
    } catch (error) {
      if (abort.signal.aborted || this.#stale(generation)) return;
      previous.onState({ pending: false, value: this.#value, error, ok: false });
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
      if (!this.#stale(generation) && (previous.poll ?? 0) > 0) {
        this.#timer = this.#setTimer(() => { void this.#request(generation); }, previous.poll!);
      }
    }
  }

}
