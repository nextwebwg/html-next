/** Renderer-neutral input bookkeeping. Accepted values remain in the renderer's existing store. */
import { createInputPort, publicInputStatus, sameInputStatus, READY_INPUT, UNRESOLVED_INPUT, type ComponentInputs, type InputSnapshot, type InputStatus } from "./inputs.js";

// No kebab segments: Vue normalizes prop keys before component setup sees them.
export const BINDING_INPUTS_PROP = "\0htmlNextInputStatus";
export type InputBindings = Readonly<Record<string, () => InputSnapshot>>;
export type InputAcceptance = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
export interface PropInputOptions {
  readonly names: readonly string[];
  readonly values: Record<string, unknown>;
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly check: (name: string, value: unknown, source: boolean, values: Readonly<Record<string, unknown>>) => InputAcceptance;
  readonly invalidate: () => void;
}
interface PropInputRecord {
  caller: unknown;
  input: unknown;
  provided: boolean;
  source: boolean;
  refused: boolean;
  accepted: boolean;
  status: InputStatus | undefined;
  revision: number;
}
export interface InputReactions {
  readonly declarations?: Readonly<Record<string, { readonly read: () => unknown; readonly status: () => InputStatus }>>;
  track(name: string, kind: "value" | "status" | "supplied"): void;
  notify?(name: string, kind: "value" | "status" | "supplied"): void;
  watch(run: () => void | (() => void)): () => void;
  untracked<T>(run: () => T): T;
}

export class PropInputs {
  #options: PropInputOptions;
  readonly #records: Record<string, PropInputRecord> = Object.create(null) as Record<string, PropInputRecord>;
  #port: ComponentInputs | undefined;
  #reactions: InputReactions | undefined;
  #portOwner: PropInputs | undefined;
  #baseRevisions: ReadonlyMap<string, number> | undefined;
  constructor(options: PropInputOptions) { this.#options = options; }
  /** Imperative code reads the connected instance, even during a speculative render. */
  get committed(): PropInputs { return this.#portOwner ?? this; }
  /** Concurrent renderers may examine a candidate without changing the connected instance. */
  fork(options: PropInputOptions): PropInputs {
    const candidate = new PropInputs({ ...options, defaults: this.#options.defaults, values: { ...this.#options.values } });
    for (const [name, record] of Object.entries(this.#records)) candidate.#records[name] = { ...record };
    candidate.#portOwner = this;
    candidate.#baseRevisions = new Map(Object.entries(this.#records).map(([name, record]) => [name, record.revision]));
    return candidate;
  }
  commit(candidate: PropInputs): void {
    const values = this.#options.values;
    for (const [name, next] of Object.entries(candidate.#records)) {
      const current = this.#record(name);
      const base = candidate.#baseRevisions?.get(name) ?? 0;
      if (current.revision !== base && current.source && !next.provided) {
        // A child layout effect may publish after this render's snapshot was checked.
        // Keep that accepted source value, while committing this caller's diagnostics.
        this.#records[name] = { ...current, caller: next.caller, refused: next.refused, accepted: next.accepted,
          input: next.refused || next.caller !== current.caller ? next.input : current.input };
      } else {
        values[name] = candidate.#options.values[name];
        this.#records[name] = { ...next, revision: next.revision === base ? current.revision : Math.max(next.revision, current.revision + 1) };
      }
    }
    this.#options = { ...candidate.#options, values };
  }
  #record(name: string): PropInputRecord {
    return this.#records[name] ??= { caller: undefined, input: null, provided: false, source: false, refused: false, accepted: true, status: undefined, revision: 0 };
  }
  #fallback(name: string): unknown { return Object.hasOwn(this.#options.defaults, name) ? this.#options.defaults[name] : null; }
  #status(record: PropInputRecord, status: InputStatus): void {
    const old = record.status;
    if (sameInputStatus(old, status)) return;
    record.status = publicInputStatus(status);
  }
  value<T>(name: string, input: unknown, bindings?: InputBindings, flags?: Record<string, boolean>): T {
    const record = this.#record(name);
    const released = record.caller !== undefined && input === undefined;
    record.caller = input;
    const upstream = bindings !== undefined && Object.hasOwn(bindings, name) ? bindings[name]!() : undefined;
    if (upstream !== undefined) {
      if (!upstream.status.ready) {
        record.revision += 1;
        this.#options.values[name] = this.#fallback(name);
        record.input = upstream.value ?? null;
        record.provided = true; record.source = false; record.refused = false; record.accepted = true;
        this.#status(record, upstream.status);
      } else {
        const result = this.#options.check(name, upstream.value === null ? this.#fallback(name) : upstream.value, false, this.#options.values);
        record.accepted = result.ok;
        if (result.ok) {
          record.revision += 1;
          this.#options.values[name] = result.value;
          record.input = upstream.value; record.provided = true; record.source = false; record.refused = false;
          this.#status(record, upstream.status);
        }
      }
    } else if (input === undefined && record.source && !released) {
      // A producer result is not a new caller input and survives ordinary component rerenders.
      record.accepted = true;
    } else {
      const candidate = input === undefined || input === null ? this.#fallback(name) : input;
      const result = input === undefined && !Object.hasOwn(this.#options.defaults, name)
        ? { ok: true as const, value: null } : this.#options.check(name, candidate, false, this.#options.values);
      record.input = input === undefined ? null : input;
      record.accepted = result.ok;
      record.refused = !result.ok && input !== undefined;
      if (result.ok) {
        record.revision += 1;
        this.#options.values[name] = result.value;
        record.provided = input !== undefined; record.source = false; record.status = undefined;
      }
    }
    if (flags !== undefined) flags[name] = record.accepted;
    return this.#options.values[name] as T;
  }
  read<T = unknown>(name: string): T { return this.#options.values[name] as T; }
  inputValue(name: string): unknown { return this.#record(name).input; }
  supplied(name: string): boolean { return this.#record(name).provided; }
  revision(name: string): number { return this.#record(name).revision; }
  status(name: string): InputStatus {
    const record = this.#record(name);
    return record.status ?? (record.provided || Object.hasOwn(this.#options.defaults, name) ? READY_INPUT : UNRESOLVED_INPUT);
  }
  publish(name: string, snapshot: InputSnapshot): boolean {
    const record = this.#record(name);
    if (record.provided) return false;
    let value = this.#fallback(name);
    if (snapshot.status.ready) {
      const result = this.#options.check(name, snapshot.value === null ? this.#fallback(name) : snapshot.value, true, this.#options.values);
      if (!result.ok) return false;
      value = result.value;
    }
    this.#options.values[name] = value;
    record.revision += 1;
    if (!record.refused) record.input = snapshot.value ?? null;
    record.source = true;
    this.#status(record, !snapshot.status.ready && Object.hasOwn(this.#options.defaults, name)
      ? { ...snapshot.status, ready: true, stale: false } : snapshot.status);
    this.#options.invalidate();
    if (this.#reactions?.notify !== undefined) {
      this.#reactions.notify(name, "value"); this.#reactions.notify(name, "status"); this.#reactions.notify(name, "supplied");
    }
    return true;
  }
  port(reactions: InputReactions): ComponentInputs {
    if (this.#portOwner !== undefined) return this.#portOwner.port(reactions);
    this.#reactions ??= reactions;
    return this.#port ??= createInputPort({
      names: this.#options.names,
      readNames: [...this.#options.names, ...Object.keys(reactions.declarations ?? {})],
      read: name => {
        if (!this.#options.names.includes(name)) return reactions.declarations![name]!.read();
        reactions.track(name, "value"); return this.read(name);
      },
      status: name => {
        if (!this.#options.names.includes(name)) return reactions.declarations![name]!.status();
        reactions.track(name, "status"); return this.status(name);
      },
      supplied: name => { reactions.track(name, "supplied"); return this.supplied(name); },
      revision: name => this.revision(name),
      publish: (name, snapshot) => this.publish(name, snapshot),
      watch: run => reactions.watch(run),
      untracked: run => reactions.untracked(run),
    });
  }
}
