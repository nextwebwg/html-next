import {
  validate,
  validityFromNative,
  type Constraint,
  type Validity,
  type ValidityError,
} from "./validate.js";
import { rewriteValiditySelectors } from "./validity-css.js";

export interface GeneralizedValidityState {
  readonly valid: boolean;
  readonly valueMissing: boolean;
  readonly typeMismatch: boolean;
  readonly patternMismatch: boolean;
  readonly tooLong: boolean;
  readonly tooShort: boolean;
  readonly rangeUnderflow: boolean;
  readonly rangeOverflow: boolean;
  readonly stepMismatch: boolean;
  readonly badInput: boolean;
  readonly customError: boolean;
  readonly schemaMismatch: boolean;
  readonly untrustedValue: boolean;
  readonly errors: readonly ValidityError[];
}

export interface ElementInternalsValidity {
  setValidity(flags?: ValidityStateFlags, message?: string, anchor?: HTMLElement): void;
}

export interface ManageValidityOptions {
  readonly internals?: ElementInternalsValidity;
  readonly value?: () => unknown;
}

interface ManagedState {
  constraint: Constraint;
  derived: Validity;
  external: readonly ValidityError[];
  interacted: boolean;
  readonly value: () => unknown;
  readonly internals?: ElementInternalsValidity;
  readonly cleanup: Array<() => void>;
}

interface InstalledStyles {
  readonly companion: HTMLStyleElement;
  readonly observer: MutationObserver;
  queued: boolean;
  readonly inaccessible: WeakSet<CSSStyleSheet>;
}

const VALID: Validity = { valid: true, errors: [] };
const states = new WeakMap<Element, ManagedState>();
const derivedStore = new WeakMap<Element, Validity>();
const externalStore = new WeakMap<Element, readonly ValidityError[]>();
const nativeBridgeMessages = new WeakMap<Element, string>();
const installedDocuments = new WeakMap<Document, InstalledStyles>();
const ariaMirrors = new WeakSet<Element>();
const formElements = new WeakMap<HTMLFormElement, Set<Element>>();
const formCleanup = new WeakMap<HTMLFormElement, () => void>();

function combine(derived: Validity, external: readonly ValidityError[]): Validity {
  const errors = [...derived.errors, ...external];
  return errors.length === 0 ? VALID : { valid: false, errors };
}

interface NativeConstraintElement extends Element {
  readonly validity: ValidityState;
  readonly validationMessage: string;
  checkValidity(): boolean;
  setCustomValidity(message: string): void;
}

function nativeControl(el: Element): el is NativeConstraintElement {
  return ["button", "fieldset", "input", "object", "output", "select", "textarea"].includes(el.localName) &&
    "validity" in el && "validationMessage" in el &&
    typeof (el as { checkValidity?: unknown }).checkValidity === "function" &&
    typeof (el as { setCustomValidity?: unknown }).setCustomValidity === "function";
}

function current(el: Element): Validity {
  const state = states.get(el);
  if (state !== undefined) return combine(state.derived, state.external);
  const derived = derivedStore.get(el);
  const external = externalStore.get(el) ?? [];
  if (derived !== undefined || external.length > 0) return combine(derived ?? VALID, external);
  return nativeControl(el) ? validityFromNative(el.validity, el.validationMessage) : VALID;
}

function validityState(validity: Validity): GeneralizedValidityState {
  const reasons = new Set(validity.errors.map((error) => error.reason));
  return Object.freeze({
    valid: validity.valid,
    valueMissing: reasons.has("valueMissing"),
    typeMismatch: reasons.has("typeMismatch"),
    patternMismatch: reasons.has("patternMismatch"),
    tooLong: reasons.has("tooLong"),
    tooShort: reasons.has("tooShort"),
    rangeUnderflow: reasons.has("rangeUnderflow"),
    rangeOverflow: reasons.has("rangeOverflow"),
    stepMismatch: reasons.has("stepMismatch"),
    badInput: reasons.has("badInput"),
    customError: reasons.has("customError"),
    schemaMismatch: reasons.has("schemaMismatch"),
    untrustedValue: reasons.has("untrustedValue"),
    errors: validity.errors,
  });
}

function firstMessage(validity: Validity): string {
  return validity.valid ? "" : validity.errors[0]!.message;
}

function flags(validity: Validity): ValidityStateFlags {
  const state = validityState(validity);
  return {
    valueMissing: state.valueMissing,
    typeMismatch: state.typeMismatch || state.schemaMismatch || state.untrustedValue,
    patternMismatch: state.patternMismatch,
    tooLong: state.tooLong,
    tooShort: state.tooShort,
    rangeUnderflow: state.rangeUnderflow,
    rangeOverflow: state.rangeOverflow,
    stepMismatch: state.stepMismatch,
    badInput: state.badInput,
    customError: state.customError,
  };
}

function reflect(el: Element, state: ManagedState | undefined): void {
  const validity = current(el);
  const message = firstMessage(validity);
  if (nativeControl(el)) {
    const needsBridge = state === undefined || state.external.length > 0 || Object.keys(state.constraint).length > 0;
    if (needsBridge) {
      el.setCustomValidity(message);
      if (message === "") nativeBridgeMessages.delete(el);
      else nativeBridgeMessages.set(el, message);
    } else {
      const priorBridge = nativeBridgeMessages.get(el);
      if (priorBridge !== undefined && el.validationMessage === priorBridge) el.setCustomValidity("");
      nativeBridgeMessages.delete(el);
    }
    // Native form-associated elements already own :valid/:invalid/:user-invalid. Mirroring
    // them would leak polyfill bookkeeping into otherwise unchanged native markup.
    el.removeAttribute("data-valid");
    el.removeAttribute("data-invalid");
    el.removeAttribute("data-user-invalid");
    return;
  } else if (state?.internals !== undefined) {
    state.internals.setValidity(validity.valid ? {} : flags(validity), message);
  }

  if (validity.valid) {
    el.removeAttribute("data-invalid");
    el.setAttribute("data-valid", "");
    if (ariaMirrors.has(el)) {
      el.removeAttribute("aria-invalid");
      ariaMirrors.delete(el);
    }
  } else {
    el.removeAttribute("data-valid");
    el.setAttribute("data-invalid", "");
    if (!el.hasAttribute("aria-invalid") || ariaMirrors.has(el)) {
      el.setAttribute("aria-invalid", "true");
      ariaMirrors.add(el);
    }
  }
  if (state?.interacted === true && !validity.valid) el.setAttribute("data-user-invalid", "");
  else el.removeAttribute("data-user-invalid");
}

function styleText(document: Document, companion: HTMLStyleElement, inaccessible: WeakSet<CSSStyleSheet>): string {
  const mirrored: string[] = [];
  const sheets = new Set<CSSStyleSheet>([
    ...Array.from(document.styleSheets),
    ...Array.from(document.adoptedStyleSheets ?? []),
  ]);
  for (const sheet of sheets) {
    if (sheet.ownerNode === companion) continue;
    try {
      const source = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
      const rewritten = rewriteValiditySelectors(source);
      if (rewritten !== source) mirrored.push(rewritten);
    } catch {
      if (!inaccessible.has(sheet)) {
        inaccessible.add(sheet);
        document.dispatchEvent(new CustomEvent("htmlnextdiagnostic", {
          detail: {
            code: "HV001",
            message: "A stylesheet containing validity selectors could not be read. Transform cross-origin CSS with rewriteValiditySelectors() during the package build.",
          },
        }));
      }
    }
  }
  return mirrored.join("\n");
}

function refreshValidityStyles(document: Document, installed: InstalledStyles): void {
  installed.queued = false;
  const next = styleText(document, installed.companion, installed.inaccessible);
  if (installed.companion.textContent !== next) installed.companion.textContent = next;
}

function scheduleStyleRefresh(document: Document): void {
  const installed = installedDocuments.get(document);
  if (installed === undefined || installed.queued) return;
  installed.queued = true;
  queueMicrotask(() => refreshValidityStyles(document, installed));
}

const patchedCSSOM = new WeakSet<object>();
function patchCSSOM(document: Document): void {
  const prototype = document.defaultView?.CSSStyleSheet?.prototype;
  if (prototype === undefined || patchedCSSOM.has(prototype)) return;
  patchedCSSOM.add(prototype);
  for (const name of ["insertRule", "deleteRule", "replace", "replaceSync"] as const) {
    const original = prototype[name];
    if (typeof original !== "function") continue;
    Object.defineProperty(prototype, name, {
      configurable: true,
      writable: true,
      value: function (this: CSSStyleSheet, ...args: unknown[]): unknown {
        const result = (original as (...values: unknown[]) => unknown).apply(this, args);
        const refresh = (): void => {
          if (Array.from(document.styleSheets).includes(this) ||
              Array.from(document.adoptedStyleSheets ?? []).includes(this)) {
            scheduleStyleRefresh(document);
          }
        };
        if (result instanceof Promise) void result.finally(refresh);
        else refresh();
        return result;
      },
    });
  }
}

/** Install automatic selector mirroring for inline, linked, and constructed author CSS. */
export function installValidityStyles(document: Document): void {
  if (installedDocuments.has(document)) return;
  const companion = document.createElement("style");
  companion.setAttribute("data-html-next-validity-styles", "");
  document.head.append(companion);
  let installed: InstalledStyles;
  const observer = new MutationObserver((mutations) => {
    if (mutations.every((mutation) => mutation.target === companion || companion.contains(mutation.target))) return;
    for (const link of Array.from(document.querySelectorAll("link[rel=stylesheet]"))) {
      link.addEventListener("load", () => scheduleStyleRefresh(document), { once: true });
    }
    scheduleStyleRefresh(document);
  });
  installed = { companion, observer, queued: false, inaccessible: new WeakSet() };
  observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
  installedDocuments.set(document, installed);
  patchCSSOM(document);
  refreshValidityStyles(document, installed);
}

function readValueUnmanaged(el: Element): unknown {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    return el.value;
  }
  if (el instanceof HTMLSelectElement) {
    return el.multiple ? Array.from(el.selectedOptions, (option) => option.value) : el.value;
  }
  if (el instanceof HTMLTextAreaElement) return el.value;
  return (el as unknown as { value?: unknown }).value ?? el.getAttribute("data-value") ?? el.getAttribute("value");
}

/** Read the current value of a native control or generalized managed element. */
export function readValue(el: Element): unknown {
  return states.get(el)?.value() ?? readValueUnmanaged(el);
}

/** The combined derived and externally supplied issue list. */
export function getElementValidity(el: Element): Validity {
  return current(el);
}

/** Native-shaped flags plus HTML Next's detailed issue list. */
export function getElementValidityState(el: Element): GeneralizedValidityState {
  return validityState(current(el));
}

export function validationMessage(el: Element): string {
  return firstMessage(current(el));
}

/** Set derived validity. Explicit custom/application issues remain intact. */
export function setElementValidity(el: Element, validity: Validity): void {
  installValidityStyles(el.ownerDocument);
  derivedStore.set(el, validity);
  const state = states.get(el);
  if (state !== undefined) state.derived = validity;
  reflect(el, state);
}

/** Set or clear the independent application-authored issue channel. */
export function setExternalValidity(el: Element, errors: readonly ValidityError[] | string): void {
  const normalized = typeof errors === "string"
    ? errors === "" ? [] : [{ reason: "customError" as const, message: errors }]
    : errors;
  externalStore.set(el, normalized);
  const state = states.get(el);
  if (state !== undefined) state.external = normalized;
  reflect(el, state);
}

function dispatchInvalid(el: Element, validity: Validity): void {
  if (!validity.valid) el.dispatchEvent(new Event("invalid", { cancelable: true }));
}

function derive(el: Element, state: ManagedState): Validity {
  if (nativeControl(el) && Object.keys(state.constraint).length === 0) {
    const priorBridge = nativeBridgeMessages.get(el);
    if (priorBridge !== undefined && el.validationMessage === priorBridge) el.setCustomValidity("");
    nativeBridgeMessages.delete(el);
    return validityFromNative(el.validity, el.validationMessage);
  }
  return validate(state.value(), state.constraint);
}

function check(el: Element, markInteracted: boolean, dispatch: boolean): boolean {
  const state = states.get(el);
  if (state !== undefined) {
    if (markInteracted) state.interacted = true;
    state.derived = derive(el, state);
    derivedStore.set(el, state.derived);
  }
  reflect(el, state);
  const validity = current(el);
  if (dispatch) dispatchInvalid(el, validity);
  return validity.valid;
}

function installFormParticipation(el: Element, state: ManagedState): void {
  const form = el.closest("form");
  if (!(form instanceof HTMLFormElement)) return;
  let elements = formElements.get(form);
  if (elements === undefined) {
    elements = new Set();
    formElements.set(form, elements);
    const submit = (event: Event): void => {
      let firstInvalid: HTMLElement | undefined;
      for (const element of formElements.get(form) ?? []) {
        if (!element.isConnected) continue;
        if (!check(element, true, true)) firstInvalid ??= element as HTMLElement;
      }
      if (firstInvalid !== undefined) {
        event.preventDefault();
        firstInvalid.focus?.();
      }
    };
    const reset = (): void => {
      queueMicrotask(() => {
        for (const element of formElements.get(form) ?? []) {
          const managed = states.get(element);
          if (managed === undefined) continue;
          managed.interacted = false;
          managed.derived = derive(element, managed);
          derivedStore.set(element, managed.derived);
          reflect(element, managed);
        }
      });
    };
    form.addEventListener("submit", submit, true);
    form.addEventListener("reset", reset);
    formCleanup.set(form, () => {
      form.removeEventListener("submit", submit, true);
      form.removeEventListener("reset", reset);
    });
  }
  elements.add(el);
  state.cleanup.push(() => {
    const currentElements = formElements.get(form);
    currentElements?.delete(el);
    if (currentElements?.size === 0) {
      formCleanup.get(form)?.();
      formCleanup.delete(form);
      formElements.delete(form);
    }
  });
}

function installFacade(el: Element): void {
  const target = el as Element & Record<string, unknown>;
  const descriptors: PropertyDescriptorMap = {};
  if (!("validity" in target)) descriptors.validity = { configurable: true, get: () => getElementValidityState(el) };
  if (!("validationMessage" in target)) descriptors.validationMessage = { configurable: true, get: () => validationMessage(el) };
  if (!("willValidate" in target)) descriptors.willValidate = { configurable: true, get: () => true };
  if (!("checkValidity" in target)) descriptors.checkValidity = { configurable: true, value: () => check(el, false, true) };
  if (!("reportValidity" in target)) descriptors.reportValidity = { configurable: true, value: () => check(el, true, true) };
  if (!("setCustomValidity" in target)) descriptors.setCustomValidity = {
    configurable: true,
    value: (message: string) => setExternalValidity(el, message),
  };
  if (!("setValidity" in target)) descriptors.setValidity = {
    configurable: true,
    value: (errors: readonly ValidityError[] = []) => setExternalValidity(el, errors),
  };
  if (!("validate" in target)) descriptors.validate = {
    configurable: true,
    value: () => validateElement(el, states.get(el)?.constraint ?? {}),
  };
  Object.defineProperties(target, descriptors);
}

/** Opt an element into native-shaped generalized validity. */
export function manageElementValidity(
  el: Element,
  constraint: Constraint = {},
  options: ManageValidityOptions = {},
): () => void {
  unmanageElementValidity(el);
  const state: ManagedState = {
    constraint,
    derived: VALID,
    external: externalStore.get(el) ?? [],
    interacted: false,
    value: options.value ?? (() => readValueUnmanaged(el)),
    ...(options.internals === undefined ? {} : { internals: options.internals }),
    cleanup: [],
  };
  states.set(el, state);
  installValidityStyles(el.ownerDocument);
  installFacade(el);
  const update = (): void => {
    state.interacted = true;
    state.derived = derive(el, state);
    derivedStore.set(el, state.derived);
    reflect(el, state);
  };
  el.addEventListener("input", update);
  el.addEventListener("change", update);
  el.addEventListener("blur", update, true);
  state.cleanup.push(
    () => el.removeEventListener("input", update),
    () => el.removeEventListener("change", update),
    () => el.removeEventListener("blur", update, true),
  );
  installFormParticipation(el, state);
  state.derived = derive(el, state);
  derivedStore.set(el, state.derived);
  reflect(el, state);
  return () => unmanageElementValidity(el);
}

export function unmanageElementValidity(el: Element): void {
  const state = states.get(el);
  if (state === undefined) return;
  for (const cleanup of state.cleanup) cleanup();
  states.delete(el);
}

/** Recompute after a programmatic binding change without marking the element user-touched. */
export function refreshElementValidity(el: Element): Validity {
  const state = states.get(el);
  if (state === undefined) return current(el);
  state.derived = derive(el, state);
  derivedStore.set(el, state.derived);
  reflect(el, state);
  return current(el);
}

/** Explicit validation marks interaction state and dispatches `invalid` when needed. */
export function validateElement(el: Element, constraint?: Constraint): Validity {
  let state = states.get(el);
  if (state === undefined) {
    manageElementValidity(el, constraint ?? {});
    state = states.get(el)!;
  } else if (constraint !== undefined) {
    state.constraint = constraint;
  }
  check(el, true, true);
  return current(el);
}
