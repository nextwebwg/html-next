import type { Scope, Value } from "./expression.js";
import { fail } from "./diagnostics.js";

type Cleanup = void | (() => void);
interface Dependency {
  first: Subscription | undefined;
  last: Subscription | undefined;
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
  #flushId = 0;
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

  flush(): void {
    if (this.#flushing) return;
    this.#flushing = true;
    const flushId = ++this.#flushId;
    try {
      while (this.#pending.length > 0) {
        const effects = this.#pending.sort(
          (left, right) => left.priority - right.priority || left.id - right.id,
        );
        this.#pending = [];
        for (const effect of effects) {
          if (effect.flushId === flushId) effect.flushCount += 1;
          else {
            effect.flushId = flushId;
            effect.flushCount = 1;
          }
          if (effect.flushCount > maximumExecutionsPerFlush) {
            this.#pending = [];
            fail("HR006", "A reactive effect exceeded the per-flush execution limit.");
          }
          effect.execute();
        }
      }
    } finally {
      this.#flushing = false;
    }
  }
}

export class ReactiveEffect {
  readonly id = nextEffectId++;
  dependencies: Subscription | undefined = undefined;
  flushCount = 0;
  flushId = 0;
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
    this.#cleanup?.();
    this.#cleanup = undefined;
    const previous = activeEffect;
    // oxlint-disable-next-line typescript/no-this-alias
    activeEffect = this;
    try {
      this.#cleanup = this.run();
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

function track(dependency: Dependency): void {
  if (activeEffect === undefined || activeEffect.stopped) return;
  activeEffect.track(dependency);
}

function trigger(dependency: Dependency | undefined): void {
  for (let subscription = dependency?.first; subscription !== undefined; ) {
    const next = subscription.nextSubscriber;
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
  readonly #values = new Map<string, Value>();
  readonly #subscribers = new Map<string, Dependency>();

  constructor(
    values: Iterable<readonly [string, Value]> = [],
    readonly scheduler = new ReactiveScheduler(),
    readonly parent?: ReactiveScope,
  ) {
    for (const [name, value] of values) this.#values.set(name, this.#wrap(value));
  }

  get size(): number {
    return new Set(this.keys()).size;
  }

  has(name: string): boolean {
    return this.#values.has(name) || this.parent?.has(name) === true;
  }

  get(name: string): Value | undefined {
    if (!this.#values.has(name)) return this.parent?.get(name);
    if (activeEffect !== undefined) {
      let subscribers = this.#subscribers.get(name);
      if (subscribers === undefined) {
        subscribers = { first: undefined, last: undefined };
        this.#subscribers.set(name, subscribers);
      }
      track(subscribers);
    }
    return this.#values.get(name);
  }

  set(name: string, value: Value): void {
    const wrapped = this.#wrap(value);
    if (Object.is(this.#values.get(name), wrapped) && this.#values.has(name)) return;
    this.#values.set(name, wrapped);
    trigger(this.#subscribers.get(name));
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
      ...Array.from(this.#values),
    ]);
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
          track(subscribers);
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
