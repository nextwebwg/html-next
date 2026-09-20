import type { Scope, Value } from "./expression.js";
import { fail } from "./diagnostics.js";

type Cleanup = void | (() => void);
interface Dependency {
  first: Subscription | undefined;
  last: Subscription | undefined;
}

interface ReactiveCell extends Dependency {
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
    if (effect.stopped || this.#pending.includes(effect)) return;
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
      if (subscription.effect.scheduler !== this) {
        // Entry requires an empty queue and scheduling starts only after this loop, so the
        // partially collected batch is private and can be discarded before the safe fallback.
        this.#pending = [];
        return false;
      }
      this.#pending.push(subscription.effect);
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
    if (this.#flushing) return;
    this.#flushing = true;
    let rounds = 0;
    try {
      while (this.#pending.length > 0) {
        rounds += 1;
        if (rounds > maximumExecutionsPerFlush) {
          this.#pending = [];
          fail("HR006", "A reactive flush exceeded the propagation-depth limit.");
        }
        const effects = this.#pending;
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
        let index = 0;
        do {
          const effect = effects[index]!;
          effect.execute();
          index += 1;
        } while (index < effects.length);
      }
    } finally {
      this.#flushing = false;
    }
  }
}

export class ReactiveEffect {
  readonly id = nextEffectId++;
  dependencies: Subscription | undefined = undefined;
  stopped = false;
  paused = false;
  #cleanup: Cleanup = undefined;
  #dependencyTail: Subscription | undefined = undefined;

  constructor(
    readonly scheduler: ReactiveScheduler,
    readonly run: () => Cleanup,
    readonly priority: number,
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
    const last = dependency.last;
    subscription.previousSubscriber = last;
    if (last === undefined) dependency.first = subscription;
    else last.nextSubscriber = subscription;
    dependency.last = subscription;
  }

  schedule(): void {
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

function trigger(dependency: Dependency | undefined): void {
  if (dependency?.first === undefined) return;
  if (dependency.first !== dependency.last &&
    dependency.first.effect.scheduler.enqueueDependency(dependency)) return;
  for (let subscription: Subscription | undefined = dependency.first;
    subscription !== undefined; ) {
    const next: Subscription | undefined = subscription.nextSubscriber;
    subscription.effect.schedule();
    subscription = next;
  }
}

export function createEffect(
  scheduler: ReactiveScheduler,
  run: () => Cleanup,
  priority = 1,
): ReactiveEffect {
  const effect = new ReactiveEffect(scheduler, run, priority);
  effect.execute();
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
    return new Set(this.keys()).size;
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

  fork(values: Iterable<readonly [string, Value]> = []): ReactiveScope {
    return new ReactiveScope(values, this.scheduler, this);
  }

  entries(): MapIterator<[string, Value]> {
    return this.#snapshot().entries();
  }

  keys(): MapIterator<string> {
    return this.#snapshot().keys();
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
      ...Array.from(this.#cells, ([name, cell]) => [name, cell.value] as const),
    ]);
  }

  #local(name: string): ReactiveCell | undefined {
    if (name !== this.#cachedName) {
      this.#cachedName = name;
      this.#cachedCell = this.#cells.get(name);
    }
    return this.#cachedCell;
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
