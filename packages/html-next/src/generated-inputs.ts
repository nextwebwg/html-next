/** Input availability for compiled components, using their existing values and scheduler. */
import { createInputPort, READY_INPUT, UNRESOLVED_INPUT, requireInputStatus, type ComponentInputs, type InputSnapshot, type InputStatus } from "./inputs.js";
import { chosen, type GeneratedInstance, type GeneratedPropRecord } from "./generated-runtime.js";
import { createComputed, createEffect, notifyPropertySet, trackProperty, untracked } from "./reactivity.js";

function statusOf(record: GeneratedPropRecord, name: string): InputStatus {
  const statuses = record.a ??= Object.create(null) as Record<string, InputStatus>;
  trackProperty(statuses, name);
  if (statuses[name] !== undefined) return statuses[name];
  trackProperty(record.i, name);
  const input = record.i[name]!;
  return (input.provided ?? input.present) || input.producer && input.present || record.D.props[name]!.default !== undefined
    ? READY_INPUT : UNRESOLVED_INPUT;
}

/** The structural planner supplies a normal value only for non-prop declarations. */
export function awaitInput(record: GeneratedPropRecord | undefined, name: string, handlesError: boolean, value?: unknown): InputStatus {
  return requireInputStatus(record === undefined
    ? value === undefined ? UNRESOLVED_INPUT : READY_INPUT
    : statusOf(record, name), handlesError);
}

/** Availability travels with a compiler-owned binding, without wrapping the component value. */
export function bindInput(child: GeneratedInstance, name: string, snapshot: InputSnapshot): void {
  const record = child.B!;
  if (snapshot.status.ready) {
    const props = record.D.props;
    const prop = props[name]!;
    const candidate = snapshot.value === null && prop.default !== undefined ? prop.default : snapshot.value;
    const values = Object.fromEntries(Object.keys(props).map(key => [key, record.h[key]!.value]));
    if (prop.select !== undefined && props[prop.select.from] === undefined) values[prop.select.from] = record.v[record.n.indexOf(prop.select.from)];
    const checks = chosen(props, prop, values);
    if (checks === null || !(candidate === null && !prop.required) && !checks.c(candidate, name, "value").ok) return;
    record.u!({ [name]: snapshot.value }, { [name]: snapshot.status });
    return;
  } else {
    if (record.r?.[name] !== undefined) record.r[name] += 1;
    const previous = record.i[name]!;
    record.i[name] = { ...previous, provided: true };
    notifyPropertySet(record.i, name, previous, record.i[name], undefined);
  }
  record.p!(name, snapshot.status);
}

export function generatedInputs(instance: GeneratedInstance): ComponentInputs {
  if (instance.P !== undefined) return instance.P;
  const record = instance.B!;
  const { props } = record.D;
  const names = Object.keys(props);
  const at = (name: string) => record.n.length + names.indexOf(name);
  const supplied = Object.fromEntries(names.map(name => [name, createComputed(instance.q, () => {
    trackProperty(record.i, name);
    const input = record.i[name]!;
    return input.provided ?? (input.present && !input.producer);
  })]));
  return instance.P = createInputPort({
    names,
    readNames: [...names, ...instance.S.n],
    read: name => Object.hasOwn(props, name) ? record.h[name]!.value : instance.s[name],
    status: name => {
      if (Object.hasOwn(props, name)) return statusOf(record, name);
      const index = instance.S.n.indexOf(name);
      if (index >= (instance.S.k ?? instance.S.n.length)) instance.X?.w.add(index);
      const status = instance.X?.i?.(index) ?? (instance.s[name] === undefined ? UNRESOLVED_INPUT : READY_INPUT);
      if (instance.X?.a !== undefined) trackProperty(instance.X.a, index);
      return status;
    },
    supplied: name => supplied[name]!.get(),
    revision: name => {
      const revisions = record.r ??= Object.create(null) as Record<string, number>;
      return revisions[name] ??= 0;
    },
    untracked,
    watch: run => { const effect = createEffect(instance.q, run); return () => effect.stop(); },
    publish(name, snapshot) {
      const prop = props[name]!;
      let value: unknown = prop.default === undefined ? null : prop.default;
      if (snapshot.status.ready) {
        const candidate = snapshot.value === null ? value : snapshot.value;
        const values = Object.fromEntries(names.map(key => [key, key === name ? candidate : record.h[key]!.value]));
        if (prop.select !== undefined && props[prop.select.from] === undefined) values[prop.select.from] = record.v[record.n.indexOf(prop.select.from)];
        const checks = chosen(props, prop, values);
        if (checks === null) return false;
        const accepted = candidate === null && !prop.required
          ? { ok: true as const, value: null } : checks.c(candidate, name, "value");
        if (!accepted.ok) return false;
        value = accepted.value;
      }
      const previous = record.i[name]!;
      if (record.r?.[name] !== undefined) record.r[name] += 1;
      if ((!previous.present || previous.producer) && (!Object.is(previous.value, snapshot.value ?? null) ||
        previous.present !== snapshot.status.ready || previous.producer !== true)) {
        record.i[name] = { value: snapshot.value ?? null, source: "value", present: snapshot.status.ready, provided: false, producer: true };
        notifyPropertySet(record.i, name, previous, record.i[name], undefined);
      }
      record.x.delete(name);
      const current = record.v[at(name)];
      instance.w(at(name), value);
      notifyPropertySet(record, name, current, value, undefined);
      record.p!(name, !snapshot.status.ready && prop.default !== undefined
        ? { ...snapshot.status, ready: true, stale: false } : snapshot.status);
      return true;
    },
  });
}
