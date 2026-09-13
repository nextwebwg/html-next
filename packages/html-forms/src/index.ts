export interface FormState<T = unknown> {
  readonly pending: boolean;
  readonly value: T | null;
  readonly error: unknown;
  readonly ok: boolean;
}

export interface EnhancedFormOptions<T = unknown> {
  readonly fetch?: typeof fetch;
  readonly parse?: (response: Response) => Promise<T>;
  readonly source?: string;
  readonly parameters?: () => Readonly<Record<string, unknown>>;
  readonly onState: (state: FormState<T>) => void;
}

export interface FormRequest {
  readonly url: string;
  readonly init: RequestInit;
}

export interface FormRequestOptions {
  readonly source?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

function appendSuccessfulValue(parameters: URLSearchParams, name: string, value: FormDataEntryValue): void {
  parameters.append(name, typeof value === "string" ? value : value.name);
}

/** Builds the enhanced request from the browser's native successful-controls set. */
export function buildFormRequest(
  form: HTMLFormElement,
  submitter?: HTMLElement | null,
  options: FormRequestOptions = {},
): FormRequest {
  const submitControl = submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
    ? submitter
    : undefined;
  const action = submitControl?.hasAttribute("formaction") === true
    ? submitControl.formAction
    : options.source ?? form.action;
  const method = (
    submitControl?.hasAttribute("formmethod") === true ? submitControl.formMethod : form.method
  ).toUpperCase() || "GET";
  const enctype =
    submitControl?.hasAttribute("formenctype") === true ? submitControl.formEnctype : form.enctype;
  const data = new FormData(form, submitter ?? undefined);
  const used = new Set<string>();
  const expandedAction = (action || form.ownerDocument.URL).replace(/\{([A-Za-z_$][\w$-]*)\}/g, (_match, name: string) => {
    used.add(name);
    return encodeURIComponent(String(options.parameters?.[name] ?? ""));
  });
  for (const [name, value] of Object.entries(options.parameters ?? {})) {
    if (used.has(name)) continue;
    if (Array.isArray(value)) {
      for (const item of value) data.append(name, String(item));
    } else if (value !== undefined && value !== null) data.append(name, String(value));
  }
  const url = new URL(expandedAction, form.ownerDocument.baseURI);
  if (method === "GET" || method === "HEAD") {
    for (const [name, value] of data) appendSuccessfulValue(url.searchParams, name, value);
    return { url: url.href, init: { method } };
  }
  if (enctype === "application/x-www-form-urlencoded") {
    const body = new URLSearchParams();
    for (const [name, value] of data) appendSuccessfulValue(body, name, value);
    return { url: url.href, init: { method, body } };
  }
  if (enctype === "text/plain") {
    const body = [...data].map(([name, value]) => `${name}=${typeof value === "string" ? value : value.name}`).join("\r\n");
    return { url: url.href, init: { method, body, headers: { "content-type": "text/plain" } } };
  }
  return { url: url.href, init: { method, body: data } };
}

/** Adds abortable fetch enhancement while retaining native validation and request semantics. */
export function enhanceForm<T = unknown>(
  form: HTMLFormElement,
  options: EnhancedFormOptions<T>,
): () => void {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const parse = options.parse ?? (async (response: Response) => {
    const contentType = response.headers.get("content-type") ?? "";
    return (contentType.includes("json") ? response.json() : response.text()) as Promise<T>;
  });
  let abort: AbortController | undefined;
  let generation = 0;
  const submit = (event: SubmitEvent): void => {
    if (event.defaultPrevented || !form.checkValidity()) return;
    let built: FormRequest;
    let pending: Promise<Response>;
    const nextAbort = new AbortController();
    try {
      built = buildFormRequest(form, event.submitter, {
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(options.parameters === undefined ? {} : { parameters: options.parameters() }),
      });
      pending = request(built.url, { ...built.init, signal: nextAbort.signal });
    } catch {
      // Enhancement never started; leave the event untouched for native navigation.
      return;
    }
    event.preventDefault();
    abort?.abort();
    abort = nextAbort;
    const current = ++generation;
    options.onState({ pending: true, value: null, error: null, ok: false });
    void pending.then(async (response) => {
      if (!response.ok) throw new TypeError(`Request failed with ${response.status}.`);
      const value = await parse(response);
      if (current !== generation || nextAbort.signal.aborted) return;
      options.onState({ pending: false, value, error: null, ok: true });
      form.dispatchEvent(new CustomEvent("success", { detail: value, bubbles: true }));
    }).catch((error: unknown) => {
      if (current !== generation || nextAbort.signal.aborted) return;
      options.onState({ pending: false, value: null, error, ok: false });
      form.dispatchEvent(new CustomEvent("error", { detail: error, bubbles: true }));
    });
  };
  form.addEventListener("submit", submit);
  return () => {
    generation += 1;
    abort?.abort();
    abort = undefined;
    form.removeEventListener("submit", submit);
  };
}
