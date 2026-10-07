import { isNativeEvent } from "./freeze.js";
import { NONCONFORMING, type Scope, type Value } from "./expression.js";
import type { TypeNode } from "./type-system.js";
import { fail } from "./diagnostics.js";

type Cleanup = void | (() => void);
interface ComputedEffectOwner {
  invalidate(): void;
  refresh(): void;
}
interface Dependency {
  first: Subscription | undefined;
  last: Subscription | undefined;
}

interface ReactiveCell extends Dependency {
  computed?: ReactiveComputed<Value>;
  /** Always plain; JavaScript readers get its proxy from `get`. */
  value: Value;
}

interface Subscription {
  readonly dependency: Dependency;
  readonly effect: ReactiveEffect;
  nextDependency: Subscription | undefined;
  previousSubscriber: Subscription | undefined;
  nextSubscriber: Subscription | undefined;
}

let activeEffect: ReactiveEffect | undefined;

/** Read the current value without adding its dependencies to the enclosing effect. */
export function untracked<T>(read: () => T): T {
  const previous = activeEffect;
  activeEffect = undefined;
  try { return read(); }
  finally { activeEffect = previous; }
}
let nextEffectId = 0;
const maximumExecutionsPerFlush = 100;
const proxyCache = new WeakMap<object, object>();
/** The plain object behind each reactive proxy and writable alias. */
const plainTargets = new WeakMap<object, object>();
const objectSubscribers = new WeakMap<object, Map<PropertyKey, Dependency>>();

/** Keep a writable controller facade from becoming another layer of reactive identity. */
export function registerReactiveAlias(alias: object, value: object): void {
  const plain = toPlain(value);
  const canonical = proxyCache.get(plain);
  if (canonical === undefined) return;
  proxyCache.set(alias, canonical);
  plainTargets.set(alias, plain);
}

/**
 * Reactive storage holds plain objects, never proxies. JavaScript reads through a proxy, which
 * tracks each property it reads; the expression engine reads the plain objects with `readKey`,
 * which tracks the same (object, key) dependencies, so a write through either reaches both.
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return (plainTargets.get(value) as T | undefined) ?? value;
}

/** The dependency for one property of a plain object, created on its first tracked read. */
function propertyDependency(target: object, key: PropertyKey): Dependency {
  let properties = objectSubscribers.get(target);
  if (properties === undefined) {
    properties = new Map();
    objectSubscribers.set(target, properties);
  }
  let subscribers = properties.get(key);
  if (subscribers === undefined) {
    subscribers = { first: undefined, last: undefined };
    properties.set(key, subscribers);
  }
  return subscribers;
}

/**
 * A property read for the expression engine: tracked like a proxy read, but the object stays plain
 * and so does the result. Only records and lists take this path. Anything else (a class instance,
 * whose accessors must see the proxy as `this`) reads through its proxy.
 */
export function readKey(object: object, key: string | number): Value | undefined {
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    return toPlain((wrap(object as Value) as Record<PropertyKey, Value>)[key]);
  }
  if (activeEffect !== undefined && !Object.isFrozen(object)) {
    activeEffect.track(propertyDependency(object, typeof key === "number" ? String(key) : key));
  }
  const value = (object as Record<PropertyKey, Value | undefined>)[key];
  return value !== null && typeof value === "object" ? toPlain(value) : value;
}

/** A list's items for the expression engine, tracking its length and each index it reads. */
export function readItems(list: readonly Value[]): Value[] {
  const plain = toPlain(list);
  const length = readKey(plain, "length") as number;
  const items: Value[] = [];
  for (let index = 0; index < length; index += 1) items.push(readKey(plain, index)!);
  return items;
}

function unsubscribe(subscription: Subscription): void {
  const { dependency, previousSubscriber, nextSubscriber } = subscription;
  if (previousSubscriber === undefined) dependency.first = nextSubscriber;
  else previousSubscriber.nextSubscriber = nextSubscriber;
  if (nextSubscriber === undefined) dependency.last = previousSubscriber;
  else nextSubscriber.previousSubscriber = previousSubscriber;
}

/**
 * Returns a finished batch emptied for reuse. Most flushes carry a few effects, and popping them is
 * much cheaper than allocating a new queue (and far cheaper than `length = 0`, which V8 handles in
 * the runtime). Wide batches pop more than a fresh array costs, so they are dropped instead.
 */
function emptied(batch: ReactiveEffect[]): ReactiveEffect[] {
  if (batch.length > 8) return [];
  while (batch.length > 0) batch.pop();
  return batch;
}

export class ReactiveScheduler {
  #pending: ReactiveEffect[] = [];
  // A drained batch, emptied in place, becomes the next pending queue so flushing allocates nothing.
  #spare: ReactiveEffect[] = [];
  #scheduled = false;
  #flushing = false;

  enqueue(effect: ReactiveEffect): void {
    if (effect.stopped || effect.queued) return;
    effect.queued = true;
    this.#pending.push(effect);
    if (!this.#scheduled && !this.#flushing) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        this.flush();
      });
    }
  }

  enqueueDependency(dependency: Dependency): boolean {
    if (this.#flushing || this.#pending.length > 0) return false;
    for (let subscription: Subscription | undefined = dependency.first; subscription !== undefined;
      subscription = subscription.nextSubscriber) {
      const effect = subscription.effect;
      if (effect.scheduler !== this) {
        // Entry requires an empty queue and scheduling starts only after this loop, so the
        // partially collected batch is private and can be discarded before the safe fallback.
        for (const pending of this.#pending) pending.queued = false;
        this.#pending = [];
        return false;
      }
      if (!effect.queued) {
        effect.queued = true;
        this.#pending.push(effect);
      }
    }
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        this.flush();
      });
    }
    return true;
  }

  flush(): void {
    if (this.#flushing || this.#pending.length === 0) return;
    this.#drain();
  }

  /** Drains dependency-ordered work after the empty-queue fast path has been ruled out. */
  #drain(): void {
    this.#flushing = true;
    let rounds = 0;
    let effects: ReactiveEffect[] | undefined;
    let index = 0;
    try {
      while (this.#pending.length > 0) {
        rounds += 1;
        if (rounds > maximumExecutionsPerFlush) {
          for (const pending of this.#pending) pending.queued = false;
          this.#pending = [];
          fail("HR006", "A reactive flush exceeded the propagation-depth limit.");
        }
        effects = this.#pending;
        if (effects.length === 1) {
          this.#pending = this.#spare;
          const effect = effects[0]!;
          effect.queued = false;
          const computed = effect.computed;
          if (computed === undefined) effect.execute();
          else computed.refresh();
          this.#spare = emptied(effects);
          effects = undefined;
          continue;
        }
        if (effects.length > 1) {
          let index = 1;
          let previous = effects[0]!;
          while (index < effects.length) {
            const current = effects[index]!;
            if (previous.priority > current.priority ||
              (previous.priority === current.priority && previous.id > current.id)) break;
            previous = current;
            index += 1;
          }
          if (index < effects.length) {
            effects.sort((left, right) => left.priority - right.priority || left.id - right.id);
          }
        }
        this.#pending = this.#spare;
        index = 0;
        do {
          const effect = effects[index]!;
          effect.queued = false;
          index += 1;
          const computed = effect.computed;
          if (computed === undefined) effect.execute();
          else computed.refresh();
          if (this.#pending.length > 0) {
            this.#deferConsumersBehindComputeds(effects, index);
          }
        } while (index < effects.length);
        this.#spare = emptied(effects);
        effects = undefined;
      }
    } finally {
      if (effects !== undefined) {
        while (index < effects.length) effects[index++]!.queued = false;
        this.#spare = [];
      }
      if (this.#pending.length > 0) {
        for (const pending of this.#pending) pending.queued = false;
        this.#pending = [];
      }
      this.#flushing = false;
    }
  }

  /**
   * Any owner may reveal dirty computed work that was not in the current batch: computed refreshes
   * can expose a descendant, while an ordinary effect can write an upstream source. No remaining
   * ordinary effect may run ahead of that work, because it could demand the dirty value and then
   * be queued a second time when the computed settles. Move only ordinary owners into the next
   * sortable round; already-queued computeds may continue in dependency order.
   */
  #deferConsumersBehindComputeds(effects: ReactiveEffect[], start: number): void {
    const computed = this.#pending.some((effect) => effect.computed !== undefined);
    // Work an effect queued at a lower priority (a template binding a list update reached) runs
    // before the rest of this round's higher-priority owners, so controller effects see it done.
    let lowest = Infinity;
    for (const effect of this.#pending) if (effect.priority < lowest) lowest = effect.priority;
    if (!computed && effects.every((effect, index) => index < start || effect.priority <= lowest)) return;
    for (let index = effects.length - 1; index >= start; index -= 1) {
      const effect = effects[index]!;
      if (effect.computed !== undefined || !computed && effect.priority <= lowest) continue;
      effects.splice(index, 1);
      this.#pending.push(effect);
    }
  }
}

export class ReactiveEffect {
  readonly id = nextEffectId++;
  dependencies: Subscription | undefined = undefined;
  stopped = false;
  /** Internal ownership registration; pause keeps it, permanent stop releases it. */
  registration: { release(effect: ReactiveEffect): void } | undefined = undefined;
  paused = false;
  queued = false;
  #cleanup: Cleanup = undefined;
  #dependencyTail: Subscription | undefined = undefined;
  #tracked: Set<Dependency> | undefined = undefined;
  #inserted = false;

  constructor(
    readonly scheduler: ReactiveScheduler,
    readonly run: () => Cleanup,
    readonly priority: number,
    readonly computed?: ComputedEffectOwner,
  ) {}

  execute(): void {
    if (this.stopped || this.paused) return;
    this.#dependencyTail = undefined;
    this.#inserted = false;
    if (this.#cleanup !== undefined) {
      const cleanup = this.#cleanup;
      this.#cleanup = undefined;
      cleanup();
    }
    const previous = activeEffect;
    // oxlint-disable-next-line typescript/no-this-alias
    activeEffect = this;
    try {
      const cleanup = this.run();
      if (cleanup !== undefined) this.#cleanup = cleanup;
    } finally {
      activeEffect = previous;
      this.#tracked = undefined;
      const tail = this.#dependencyTail as Subscription | undefined;
      let subscription = tail === undefined ? this.dependencies : tail.nextDependency;
      if (tail === undefined) this.dependencies = undefined;
      else tail.nextDependency = undefined;
      while (subscription !== undefined) {
        const next = subscription.nextDependency;
        unsubscribe(subscription);
        subscription = next;
      }
    }
  }

  track(dependency: Dependency): void {
    const next =
      this.#dependencyTail === undefined
        ? this.dependencies
        : this.#dependencyTail.nextDependency;
    const reusable = next?.dependency === dependency;
    // Before any insertion, the unique old order proves this next link has not been consumed.
    if (reusable && !this.#inserted) {
      this.#dependencyTail = next;
      this.#tracked?.add(dependency);
      return;
    }
    if (this.#tracked !== undefined) {
      if (this.#tracked.has(dependency)) return;
    } else {
      let inspected = 0;
      for (let current = this.dependencies; current !== next; current = current?.nextDependency) {
        if (current?.dependency === dependency) return;
        // Keep small effects allocation-free; one wider miss indexes the consumed prefix once.
        if (++inspected === 8) {
          const tracked = new Set<Dependency>();
          for (let used = this.dependencies; used !== next; used = used!.nextDependency) {
            tracked.add(used!.dependency);
          }
          this.#tracked = tracked;
          if (tracked.has(dependency)) return;
          break;
        }
      }
    }
    this.#tracked?.add(dependency);
    if (reusable) {
      this.#dependencyTail = next;
      return;
    }
    const subscription: Subscription = {
      dependency,
      effect: this,
      nextDependency: next,
      previousSubscriber: undefined,
      nextSubscriber: undefined,
    };
    if (this.#dependencyTail === undefined) this.dependencies = subscription;
    else this.#dependencyTail.nextDependency = subscription;
    this.#dependencyTail = subscription;
    this.#inserted = true;
    const first = dependency.first;
    // Computeds lead the subscriber list so invalidation can dirty the derived graph before an
    // ordinary effect observes it. Priority-zero data effects still use normal scheduler ordering.
    if (this.computed !== undefined && first !== undefined) {
      subscription.nextSubscriber = first;
      first.previousSubscriber = subscription;
      dependency.first = subscription;
    } else {
      const last = dependency.last;
      subscription.previousSubscriber = last;
      if (last === undefined) dependency.first = subscription;
      else last.nextSubscriber = subscription;
      dependency.last = subscription;
    }
  }

  schedule(): void {
    if (!this.paused) this.scheduler.enqueue(this);
  }

  pause(): void {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.#unsubscribe();
    const cleanup = this.#cleanup;
    this.#cleanup = undefined;
    cleanup?.();
  }

  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.execute();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.#unsubscribe();
    const cleanup = this.#cleanup;
    this.#cleanup = undefined;
    const registration = this.registration;
    this.registration = undefined;
    try { cleanup?.(); }
    finally { registration?.release(this); }
  }

  #unsubscribe(): void {
    let subscription = this.dependencies;
    while (subscription !== undefined) {
      const next = subscription.nextDependency;
      unsubscribe(subscription);
      subscription = next;
    }
    this.dependencies = undefined;
    this.#dependencyTail = undefined;
    this.#tracked = undefined;
  }
}

/** A writable controller-local value that participates in the same dependency graph as scopes. */
export class ReactiveSignal<T> {
  readonly #dependency: Dependency = { first: undefined, last: undefined };
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  get(): T {
    activeEffect?.track(this.#dependency);
    return this.#value;
  }

  set(value: T): void {
    if (Object.is(this.#value, value)) return;
    this.#value = value;
    trigger(this.#dependency);
  }

  update(update: (value: T) => T): void {
    this.set(update(this.#value));
  }
}

export interface ReactiveOwner {
  pause(): void;
  resume(): void;
  stop(): void;
}

/**
 * A cached derived value. Invalidations stay lazy unless a live effect consumes the value; in that
 * case the computed refreshes after the whole upstream change has been marked dirty, so equality
 * can stop downstream work without evaluating abandoned branches.
 */
export class ReactiveComputed<T> implements ReactiveOwner {
  readonly #dependency: Dependency;
  readonly #compute: () => T;
  readonly #effect: ReactiveEffect;
  #value!: T;
  #initialized = false;
  #dirty = true;
  #evaluating = false;
  #changed = false;

  constructor(
    scheduler: ReactiveScheduler,
    compute: () => T,
    dependency: Dependency = { first: undefined, last: undefined },
  ) {
    this.#dependency = dependency;
    this.#compute = compute;
    this.#effect = new ReactiveEffect(scheduler, () => this.#evaluate(), 0, this);
  }

  get(): T {
    if (this.#effect.paused || this.#effect.stopped) return this.#readDetached();
    this.refresh();
    activeEffect?.track(this.#dependency);
    return this.#value;
  }

  invalidate(): void {
    if (this.#effect.stopped || this.#dirty) return;
    this.#dirty = true;
    const first = this.#dependency.first;
    if (first === undefined) return;
    if (first === this.#dependency.last && first.effect.computed !== undefined) {
      first.effect.computed.invalidate();
      return;
    }
    if (this.#dependency.last!.effect.computed === undefined) {
      this.#effect.scheduler.enqueue(this.#effect);
      return;
    }
    trigger(this.#dependency);
  }

  refresh(): void {
    if (this.#evaluating) fail("HR006", "A reactive computed value depends on itself.");
    if (!this.#dirty || this.#effect.stopped || this.#effect.paused) return;
    const initialized = this.#initialized;
    this.#effect.execute();
    if (initialized && this.#changed) {
      trigger(this.#dependency, activeEffect?.computed === undefined ? undefined : activeEffect);
    }
  }

  pause(): void {
    if (this.#effect.stopped || this.#effect.paused) return;
    this.#dirty = true;
    this.#effect.pause();
  }

  resume(): void {
    if (this.#effect.stopped || !this.#effect.paused) return;
    this.#effect.paused = false;
  }

  stop(): void {
    this.#effect.stop();
  }

  #readDetached(): T {
    if (this.#evaluating) fail("HR006", "A reactive computed value depends on itself.");
    const previous = activeEffect;
    this.#evaluating = true;
    activeEffect = undefined;
    try {
      return this.#compute();
    } finally {
      activeEffect = previous;
      this.#evaluating = false;
    }
  }

  #evaluate(): void {
    this.#evaluating = true;
    this.#dirty = false;
    try {
      const value = this.#compute();
      // A computation that read a value its declaration forbids has nothing to publish: keep the
      // last value and report no change, so nothing downstream recomputes from a broken contract.
      if (value === NONCONFORMING) {
        if (!this.#initialized) {
          this.#value = null as T;
          this.#initialized = true;
        }
        this.#changed = false;
        return;
      }
      this.#changed = !this.#initialized || !Object.is(this.#value, value);
      this.#value = value;
      this.#initialized = true;
    } catch (error) {
      this.#dirty = true;
      throw error;
    } finally {
      this.#evaluating = false;
    }
  }
}

function trigger(dependency: Dependency | undefined, skip?: ReactiveEffect): void {
  const first = dependency?.first;
  if (first === undefined) return;
  const multiple = first !== dependency!.last;
  if (first.effect.computed === undefined && skip === undefined && multiple &&
    first.effect.scheduler.enqueueDependency(dependency!)) return;
  for (let subscription: Subscription | undefined = first;
    subscription !== undefined; ) {
    const next: Subscription | undefined = subscription.nextSubscriber;
    const effect = subscription.effect;
    if (effect !== skip) {
      const computed = effect.computed;
      if (computed === undefined) effect.schedule();
      else computed.invalidate();
    }
    subscription = next;
  }
}

export function createSignal<T>(initialValue: T): ReactiveSignal<T> {
  return new ReactiveSignal(initialValue);
}

export function createComputed<T>(scheduler: ReactiveScheduler, compute: () => T): ReactiveComputed<T> {
  return new ReactiveComputed(scheduler, compute);
}

export function createEffect(
  scheduler: ReactiveScheduler,
  run: () => Cleanup,
  priority = 1,
  active = true,
): ReactiveEffect {
  const effect = new ReactiveEffect(scheduler, run, priority);
  if (active) effect.execute();
  else effect.paused = true;
  return effect;
}

/** A scope layer whose root reads and nested object/array paths are dependency tracked. */
export class ReactiveScope implements Scope {
  readonly #cells = new Map<string, ReactiveCell>();
  typeOfPath?: Scope["typeOfPath"];
  typeOfDeclaredPath?: ((path: string) => TypeNode | undefined) | undefined;
  #cachedName: string | undefined;
  #cachedCell: ReactiveCell | undefined;

  constructor(
    values: Iterable<readonly [string, Value]> = [],
    readonly scheduler = new ReactiveScheduler(),
    readonly parent?: ReactiveScope,
  ) {
    for (const [name, value] of values) this.set(name, value);
  }

  has(name: string): boolean {
    return this.#local(name) !== undefined || this.parent?.has(name) === true;
  }

  /** The value as JavaScript sees it: an object comes back as its proxy. */
  get(name: string): Value | undefined {
    const cell = this.#local(name);
    if (cell === undefined) return this.parent?.get(name);
    activeEffect?.track(cell);
    return wrap(cell.value);
  }

  /** The plain value, for the expression engine; see `readKey`. */
  read(name: string): Value | undefined {
    const cell = this.#local(name);
    if (cell === undefined) return this.parent?.read(name);
    activeEffect?.track(cell);
    return cell.value;
  }

  readKey(object: object, key: string | number): Value | undefined {
    return readKey(object, key);
  }

  reveal(value: Value): Value {
    return wrap(value);
  }

  set(name: string, value: Value): void {
    const plain = toPlain(value);
    let cell = this.#local(name);
    if (cell === undefined) {
      cell = { value: plain, first: undefined, last: undefined };
      this.#cells.set(name, cell);
      this.#cachedCell = cell;
      return;
    }
    if (Object.is(cell.value, plain)) return;
    cell.value = plain;
    trigger(cell);
  }

  /** Write an existing lexical binding without shadowing it in a child scope. */
  setExisting(name: string, value: Value): void {
    if (this.#local(name) === undefined && this.parent !== undefined) {
      this.parent.setExisting(name, value);
      return;
    }
    this.set(name, value);
  }

  /** Defines a named derived scope value without evaluating it until a consumer reads it. */
  defineComputed(name: string, compute: () => Value): ReactiveComputed<Value> {
    let cell = this.#local(name);
    if (cell === undefined) {
      cell = { value: null, first: undefined, last: undefined };
      this.#cells.set(name, cell);
      this.#cachedCell = cell;
    }
    const computed = new ReactiveComputed(
      this.scheduler,
      () => toPlain(compute()),
      cell,
    );
    cell.computed = computed;
    // Most scopes contain only writable values. Install the extra computed lookup only on scopes
    // that need it so ordinary state reads retain the minimal hot path.
    if (!Object.hasOwn(this, "get")) {
      this.get = this.#getWithComputed;
      this.read = this.#readWithComputed;
    }
    return computed;
  }

  fork(values: Iterable<readonly [string, Value]> = []): ReactiveScope {
    const child = new ReactiveScope(values, this.scheduler, this);
    child.typeOfPath = this.typeOfPath;
    child.typeOfDeclaredPath = this.typeOfDeclaredPath;
    return child;
  }

  #local(name: string): ReactiveCell | undefined {
    if (name !== this.#cachedName) {
      this.#cachedName = name;
      this.#cachedCell = this.#cells.get(name);
    }
    return this.#cachedCell;
  }

  #getWithComputed(name: string): Value | undefined {
    const cell = this.#local(name);
    if (cell === undefined) return this.parent?.get(name);
    if (cell.computed !== undefined) return wrap(cell.computed.get());
    activeEffect?.track(cell);
    return wrap(cell.value);
  }

  #readWithComputed(name: string): Value | undefined {
    const cell = this.#local(name);
    if (cell === undefined) return this.parent?.read(name);
    if (cell.computed !== undefined) return cell.computed.get();
    activeEffect?.track(cell);
    return cell.value;
  }
}

/**
 * The traps every reactive proxy shares. They keep no per-proxy or per-scope state: dependencies
 * live in the weak target registries, so one handler serves every proxy.
 */
const reactiveHandler: ProxyHandler<object> = {
  get(target, key, receiver) {
    if (activeEffect !== undefined) activeEffect.track(propertyDependency(target, key));
    return wrap(Reflect.get(target, key, receiver) as Value);
  },
  set(target, key, next, receiver) {
    const previousLength = Array.isArray(target) ? target.length : undefined;
    const previous = toPlain(Reflect.get(target, key, receiver));
    const plain = toPlain(next as Value);
    const result = Reflect.set(target, key, plain, receiver);
    if (!Object.is(previous, plain)) trigger(objectSubscribers.get(target)?.get(key));
    // Defining an array index can extend length before push writes that same length again.
    if (key !== "length" && previousLength !== undefined && previousLength !== (target as Value[]).length) {
      trigger(objectSubscribers.get(target)?.get("length"));
    }
    // ArraySetLength deletes indices inside the native setter, bypassing deleteProperty.
    if (key === "length" && previousLength !== undefined && (target as Value[]).length < previousLength) {
      const length = (target as Value[]).length;
      for (const [property, subscribers] of objectSubscribers.get(target) ?? []) {
        if (typeof property !== "string") continue;
        const index = Number(property);
        if (Number.isInteger(index) && String(index) === property && index >= length && index < previousLength) {
          trigger(subscribers);
        }
      }
    }
    return result;
  },
  deleteProperty(target, key) {
    const had = Reflect.has(target, key);
    const result = Reflect.deleteProperty(target, key);
    if (had) trigger(objectSubscribers.get(target)?.get(key));
    return result;
  },
};

// ponytail: the three functions below repeat the traps' bodies for compiled controller facades,
// which track and notify raw targets through the same registry. The traps keep their own inline
// copies because calling these from them grows every runtime bundle (~30 B gzip); only
// generated-runtime imports these, so other bundles shake them out.

/** Records that the running effect read `target[key]`; the raw target is the dependency's identity. */
export function trackProperty(target: object, key: PropertyKey): void {
  if (activeEffect === undefined) return;
  let properties = objectSubscribers.get(target);
  if (properties === undefined) {
    properties = new Map();
    objectSubscribers.set(target, properties);
  }
  let subscribers = properties.get(key);
  if (subscribers === undefined) {
    subscribers = { first: undefined, last: undefined };
    properties.set(key, subscribers);
  }
  activeEffect.track(subscribers);
}

/**
 * Notifies the readers a property write affects, after the write. `previousLength` is the array's
 * length before it, or undefined for other targets.
 */
export function notifyPropertySet(
  target: object,
  key: PropertyKey,
  previous: unknown,
  next: unknown,
  previousLength: number | undefined,
): void {
  if (!Object.is(previous, next)) trigger(objectSubscribers.get(target)?.get(key));
  // Defining an array index can extend length before push writes that same length again.
  if (key !== "length" && previousLength !== undefined && previousLength !== (target as Value[]).length) {
    trigger(objectSubscribers.get(target)?.get("length"));
  }
  // ArraySetLength deletes indices inside the native setter, bypassing deleteProperty.
  if (key === "length" && previousLength !== undefined && (target as Value[]).length < previousLength) {
    const length = (target as Value[]).length;
    for (const [property, subscribers] of objectSubscribers.get(target) ?? []) {
      if (typeof property !== "string") continue;
      const index = Number(property);
      if (Number.isInteger(index) && String(index) === property && index >= length && index < previousLength) {
        trigger(subscribers);
      }
    }
  }
}

/** Notifies the readers of a deleted property; `had` is whether it existed before the delete. */
export function notifyPropertyDelete(target: object, key: PropertyKey, had: boolean): void {
  if (had) trigger(objectSubscribers.get(target)?.get(key));
}

/** The canonical reactive proxy for a mutable object; primitives, frozen values and events stay as they are. */
function wrap(value: Value): Value {
  if (value === null || typeof value !== "object") return value;
  const cached = proxyCache.get(value);
  if (cached !== undefined) return cached as Value;
  // Already a proxy: storage is plain, so this is rare enough for a second lookup.
  if (plainTargets.has(value) || isNativeEvent(value) || Object.isFrozen(value)) return value;
  const proxy = new Proxy(value, reactiveHandler);
  proxyCache.set(value, proxy);
  plainTargets.set(proxy, value);
  return proxy as Value;
}
