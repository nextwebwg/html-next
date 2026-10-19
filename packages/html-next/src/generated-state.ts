/** One-time state ownership for native output; accepted values stay in the generated values array. */
import { ABSENT, NONCONFORMING } from "./expression-values.js";
import { copyStateSeed, evaluateInput, READY_INPUT, UNRESOLVED_INPUT, sameInputStatus, type InputStatus } from "./inputs.js";
import { createEffect, notifyPropertySet, type ReactiveEffect } from "./reactivity.js";
import { computedCycle, conforms, warnOnce, type GeneratedChannel, type GeneratedInstance, type GeneratedStateSpec } from "./generated-runtime.js";
import type { RenderedInstanceRecord } from "./rendered-form.js";

export interface GeneratedStateInitializers {
  read(index: number): unknown;
  status(index: number): InputStatus;
  claim(index: number): void;
  changed(): void;
  attach(instance: GeneratedInstance): void;
  all(): void;
  initialized(): readonly string[];
}

export function stateInitializers(spec: GeneratedStateSpec, values: unknown[], channel: GeneratedChannel,
  plans: Readonly<Record<number, () => unknown>>, restored?: RenderedInstanceRecord,
): GeneratedStateInitializers {
  const names = Object.keys(plans).map(Number);
  const done = new Set(names.filter(index => restored !== undefined && Object.hasOwn(restored.state, spec.n[index]!) &&
    (restored.initialized === undefined || restored.initialized.includes(spec.n[index]!))));
  const evaluating = new Set<number>();
  const statuses = channel.a!;
  let instance: GeneratedInstance | undefined;
  let job: ReactiveEffect | undefined;
  const assign = (index: number, value: unknown): void => {
    if (instance === undefined) { values[index] = value; channel.e += 1; }
    else instance.w(index, value);
  };
  const status = (index: number, next: InputStatus): boolean => {
    const previous = statuses[index];
    if (sameInputStatus(previous, next)) return false;
    statuses[index] = next;
    notifyPropertySet(statuses, index, previous, next, undefined);
    return true;
  };
  const owner: GeneratedStateInitializers = {
    read(index) {
      if (!Object.hasOwn(plans, index) || done.has(index)) return values[index];
      if (evaluating.has(index)) computedCycle();
      evaluating.add(index);
      try {
        const result = evaluateInput(plans[index]!, statuses[index], NONCONFORMING);
        if (result.status.ready && !result.status.stale && result.value !== undefined && result.value !== ABSENT && result.value !== NONCONFORMING) {
          if (conforms(result.value, spec.t[index]!)) {
            done.add(index);
            status(index, READY_INPUT);
            assign(index, copyStateSeed(result.value));
            return values[index];
          }
          warnOnce(spec, `initializer:${spec.n[index]}`, `Initializer for \`${spec.n[index]}\` does not satisfy its declared type.`);
        }
        if (status(index, { ...result.status, ready: false, stale: false })) assign(index, values[index]);
        return values[index];
      } finally { evaluating.delete(index); }
    },
    status(index) {
      owner.read(index);
      return !Object.hasOwn(plans, index) || done.has(index) ? values[index] === undefined ? UNRESOLVED_INPUT : READY_INPUT : statuses[index] ?? UNRESOLVED_INPUT;
    },
    claim(index) {
      if (!Object.hasOwn(plans, index) || done.has(index)) return;
      done.add(index);
      status(index, READY_INPUT);
      assign(index, values[index]);
    },
    changed() { if (done.size !== names.length) job?.schedule(); },
    attach(current) {
      instance = current;
      job = createEffect(current.q, () => owner.all(), 0);
      current.o.push(job);
    },
    all() { for (const index of names) owner.read(index); },
    initialized: () => names.filter(index => done.has(index)).map(index => spec.n[index]!),
  };
  return owner;
}
