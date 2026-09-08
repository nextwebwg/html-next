import { validate, type Constraint, type Validity } from "./validate.js";

/**
 * The DOM side of the Validation module: give any element the same validity surface a form
 * control has. Where the element is a real form control, delegate to the native Constraint
 * Validation API so real `:invalid` and form submission keep working; everywhere else, apply
 * a general shim (`aria-invalid` + `[data-invalid]` + the `invalid` event) since a polyfill
 * cannot set the real `:invalid` pseudo-class on an arbitrary element. That shim is exactly
 * what the platform should make unnecessary by exposing validity on any element.
 */

const store = new WeakMap<Element, Validity>();
const VALID: Validity = { valid: true, errors: [] };

function supportsSetCustomValidity(
  el: Element,
): el is Element & { setCustomValidity(message: string): void } {
  return typeof (el as { setCustomValidity?: unknown }).setCustomValidity === "function";
}

/** Read the current value of an element for validation. */
export function readValue(el: Element): unknown {
  if (el instanceof HTMLInputElement) {
    return el.type === "checkbox" || el.type === "radio" ? el.checked : el.value;
  }
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  // A non-control element carries its value wherever the binding put it; the shim reads a
  // `data-value` mirror, which is what a reactive binding would keep in sync.
  return el.getAttribute("data-value");
}

/** The element's current validity (valid until something sets otherwise). */
export function getElementValidity(el: Element): Validity {
  return store.get(el) ?? VALID;
}

/** The first error's message, or "" when valid — mirrors `HTMLElement.validationMessage`. */
export function validationMessage(el: Element): string {
  const validity = getElementValidity(el);
  return validity.valid ? "" : validity.errors[0]!.message;
}

/**
 * Set an element's validity. Native controls also get the real API (so real `:invalid` and
 * form submission work, and `customError` — the legacy "custom" bridge — is set for us);
 * every element additionally gets the general shim.
 */
export function setElementValidity(el: Element, validity: Validity): void {
  store.set(el, validity);
  const message = validity.valid ? "" : validity.errors[0]!.message;

  if (supportsSetCustomValidity(el)) {
    el.setCustomValidity(message); // "" clears it
  }

  if (validity.valid) {
    el.removeAttribute("aria-invalid");
    el.removeAttribute("data-invalid");
  } else {
    el.setAttribute("aria-invalid", "true");
    el.setAttribute("data-invalid", "");
    el.dispatchEvent(new Event("invalid", { cancelable: true }));
  }
}

/**
 * Validate an element against a constraint using its current value, set the result, and
 * return it. This is the `el.validate()` of the proposal, expressed as a function while the
 * primitive lives in userland: the element checks itself, with no value/type threading.
 */
export function validateElement(el: Element, constraint: Constraint): Validity {
  const validity = validate(readValue(el), constraint);
  setElementValidity(el, validity);
  return validity;
}
