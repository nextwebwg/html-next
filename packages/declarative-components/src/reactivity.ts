import type { Scope, Value } from "./expression.js";
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
let nextEffectId = 0;
const maximumExecutionsPerFlush = 100;
const proxyCache = new WeakMap<object, object>();
const objectSubscribers = new WeakMap<object, Map<PropertyKey, Dependency>>();

function unsubscribe(subscription: Subscription): void {
  const { dependency, previousSubscriber, nextSubscriber } = subscription;
  if (previousSubscriber === undefined) dependency.first = nextSubscriber;
  else previousSubscriber.nextSubscriber = nextSubscriber;
  if (nextSubscriber === undefined) dependency.last = previousSubscriber;
  else nextSubscriber.previousSubscriber = previousSubscriber;
}

export class ReactiveScheduler {
  #pending: ReactiveEffect[] = [];
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
        this.#pending = [];
        index = 0;
        do {
          const effect = effects[index]!;
          effect.queued = false;
          index += 1;
          if (effect.computed === undefined) effect.execute();
          else effect.computed.refresh();
          // With no remaining owner and one ordinary pending effect, the next sortable round is
          // already known. Adopt it in place, but still advance the round count so HR006 retains
          // exactly the same propagation-depth bound as the generic outer loop.
          if (this.#pending.length === 1 && index === effects.length &&
            this.#pending[0]!.computed === undefined) {
            rounds += 1;
            if (rounds > maximumExecutionsPerFlush) {
              this.#pending[0]!.queued = false;
              this.#pending = [];
              fail("HR006", "A reactive flush exceeded the propagation-depth limit.");
            }
            effects = this.#pending;
            this.#pending = [];
            index = 0;
          } else if (this.#pending.length > 0) {
            this.#deferConsumersBehindComputeds(effects, index);
          }
        } while (index < effects.length);
        effects = undefined;
      }
    } finally {
      if (effects !== undefined) {
        while (index < effects.length) effects[index++]!.queued = false;
      }
      for (const pending of this.#pending) pending.queued = false;
      this.#pending = [];
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
    if (!this.#pending.some((effect) => effect.computed !== undefined)) return;
    for (let index = effects.length - 1; index >= start; index -= 1) {
      const effect = effects[index]!;
      if (effect.computed !== undefined) continue;
      effects.splice(index, 1);
      this.#pending.push(effect);
    }
  }
}

export class ReactiveEffect {
  readonly id = nextEffectId++;
  dependencies: Subscription | undefined = undefined;
  stopped = false;
  paused = false;
  queued = false;
  #cleanup: Cleanup = undefined;
  #dependencyTail: Subscription | undefined = undefined;

  constructor(
    readonly scheduler: ReactiveScheduler,
    readonly run: () => Cleanup,
    readonly priority: number,
    readonly computed?: ComputedEffectOwner,
  ) {}

  execute(): void {
    if (this.stopped || this.paused) return;
    this.#dependencyTail = undefined;
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
    if (next?.dependency === dependency) {
      this.#dependencyTail = next;
      return;
    }
    for (let current = this.dependencies; current !== next; current = current?.nextDependency) {
      if (current?.dependency === dependency) return;
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
    if (this.computed !== undefined) {
      this.computed.invalidate();
      return;
    }
    if (!this.paused) this.scheduler.enqueue(this);
  }

  pause(): void {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.#unsubscribe();
    this.#cleanup?.();
    this.#cleanup = undefined;
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
    this.#cleanup?.();
    this.#cleanup = undefined;
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
    if (activeEffect !== undefined) activeEffect.track(this.#dependency);
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
    this.#refresh();
    if (activeEffect !== undefined) activeEffect.track(this.#dependency);
    return this.#value;
  }

  invalidate(): void {
    if (this.#effect.stopped || this.#dirty) return;
    this.#dirty = true;
    for (let subscription = this.#dependency.first; subscription !== undefined;
      subscription = subscription.nextSubscriber) {
      if (subscription.effect.computed === undefined) {
        this.#effect.scheduler.enqueue(this.#effect);
        return;
      }
    }
    trigger(this.#dependency);
  }

  refresh(): void {
    this.#refresh();
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

  #refresh(): void {
    if (this.#evaluating) fail("HR006", "A reactive computed value depends on itself.");
    if (!this.#dirty || this.#effect.stopped || this.#effect.paused) return;
    const initialized = this.#initialized;
    this.#effect.execute();
    if (initialized && this.#changed) {
      trigger(this.#dependency, activeEffect?.computed === undefined ? undefined : activeEffect);
    }
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
  // A singleton computed's generic schedule path can only invalidate this same owner.
  if (!multiple && first.effect.computed !== undefined) {
    if (first.effect !== skip) first.effect.computed.invalidate();
    return;
  }
  if (first.effect.computed === undefined) {
    if (skip === undefined && multiple && first.effect.scheduler.enqueueDependency(dependency!)) return;
    for (let subscription: Subscription | undefined = first;
      subscription !== undefined; ) {
      const next: Subscription | undefined = subscription.nextSubscriber;
      if (subscription.effect !== skip) subscription.effect.schedule();
      subscription = next;
    }
    return;
  }
  for (let subscription: Subscription | undefined = first;
    subscription !== undefined; ) {
    const next: Subscription | undefined = subscription.nextSubscriber;
    if (subscription.effect !== skip) subscription.effect.schedule();
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
  #cachedName: string | undefined;
  #cachedCell: ReactiveCell | undefined;

  constructor(
    values: Iterable<readonly [string, Value]> = [],
    readonly scheduler = new ReactiveScheduler(),
    readonly parent?: ReactiveScope,
  ) {
    for (const [name, value] of values) this.set(name, value);
  }

  get size(): number {
    return this.#keySnapshot().size;
  }

  has(name: string): boolean {
    return this.#local(name) !== undefined || this.parent?.has(name) === true;
  }

  get(name: string): Value | undefined {
    const cell = this.#local(name);
    if (cell === undefined) return this.parent?.get(name);
    if (activeEffect !== undefined) activeEffect.track(cell);
    return cell.value;
  }

  set(name: string, value: Value): void {
    const wrapped = this.#wrap(value);
    let cell = this.#local(name);
    if (cell === undefined) {
      cell = { value: wrapped, first: undefined, last: undefined };
      this.#cells.set(name, cell);
      this.#cachedCell = cell;
      return;
    }
    if (Object.is(cell.value, wrapped)) return;
    cell.value = wrapped;
    trigger(cell);
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
      () => this.#wrap(compute()),
      cell,
    );
    cell.computed = computed;
    // Most scopes contain only writable values. Install the extra computed lookup only on scopes
    // that need it so ordinary state reads retain the minimal hot path.
    if (!Object.hasOwn(this, "get")) this.get = this.#getWithComputed;
    return computed;
  }

  fork(values: Iterable<readonly [string, Value]> = []): ReactiveScope {
    return new ReactiveScope(values, this.scheduler, this);
  }

  entries(): MapIterator<[string, Value]> {
    return this.#snapshot().entries();
  }

  keys(): MapIterator<string> {
    return this.#keySnapshot().keys();
  }

  values(): MapIterator<Value> {
    return this.#snapshot().values();
  }

  [Symbol.iterator](): MapIterator<[string, Value]> {
    return this.entries();
  }

  forEach(
    callbackfn: (value: Value, key: string, map: ReadonlyMap<string, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) callbackfn.call(thisArg, value, key, this);
  }

  #snapshot(): Map<string, Value> {
    return new Map([
      ...Array.from(this.parent?.entries() ?? []),
      ...Array.from(this.#cells, ([name, cell]) => [
        name,
        cell.computed === undefined ? cell.value : cell.computed.get(),
      ] as const),
    ]);
  }

  #keySnapshot(): Map<string, undefined> {
    const keys = new Map<string, undefined>();
    for (const name of this.parent?.keys() ?? []) keys.set(name, undefined);
    for (const name of this.#cells.keys()) keys.set(name, undefined);
    return keys;
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
    if (cell.computed !== undefined) return cell.computed.get();
    if (activeEffect !== undefined) activeEffect.track(cell);
    return cell.value;
  }

  #wrap(value: Value): Value {
    if (value === null || typeof value !== "object") return value;
    const cached = proxyCache.get(value);
    if (cached !== undefined) return cached as Value;
    const proxy = new Proxy(value, {
      get: (target, key, receiver) => {
        if (activeEffect !== undefined) {
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
        return this.#wrap(Reflect.get(target, key, receiver) as Value);
      },
      set: (target, key, next, receiver) => {
        const previous = Reflect.get(target, key, receiver);
        const wrapped = this.#wrap(next as Value);
        const result = Reflect.set(target, key, wrapped, receiver);
        if (!Object.is(previous, wrapped)) trigger(objectSubscribers.get(target)?.get(key));
        return result;
      },
      deleteProperty: (target, key) => {
        const had = Reflect.has(target, key);
        const result = Reflect.deleteProperty(target, key);
        if (had) trigger(objectSubscribers.get(target)?.get(key));
        return result;
      },
    });
    proxyCache.set(value, proxy);
    proxyCache.set(proxy, proxy);
    return proxy as Value;
  }
}
