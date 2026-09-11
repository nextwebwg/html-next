import { validate, type Constraint, type Validity } from "./validate.js";
import { rewriteValiditySelectors } from "./validity-css.js";

/**
 * The DOM side of the Validation module: give any element the same validity surface a form
 * control has. Where the element is a real form control, delegate to the native Constraint
 * Validation API so form submission keeps working; everywhere else, mirror validity into
 * internal attributes. Styles are mirrored too, so authors use the proposed `:valid` and
 * `:invalid` surface rather than polyfill-specific selectors.
 */

const store = new WeakMap<Element, Validity>();
const VALID: Validity = { valid: true, errors: [] };
const installedDocuments = new WeakMap<Document, MutationObserver>();

function refreshValidityStyles(document: Document, companion: HTMLStyleElement): void {
  const mirrored: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.ownerNode === companion) continue;
    try {
      const source = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
      const rewritten = rewriteValiditySelectors(source);
      if (rewritten !== source) mirrored.push(rewritten);
    } catch {
      // Cross-origin sheets cannot expose cssRules. Generated HTML Next CSS is rewritten
      // ahead of time; applications should run external author CSS through the same helper.
    }
  }
  companion.textContent = mirrored.join("\n");
}

/** Install automatic selector mirroring for styles added to a document. */
export function installValidityStyles(document: Document): void {
  if (installedDocuments.has(document)) return;
  const companion = document.createElement("style");
  companion.setAttribute("data-html-next-validity-styles", "");
  document.head.append(companion);
  refreshValidityStyles(document, companion);

  const observer = new MutationObserver((mutations) => {
    if (mutations.every((mutation) => mutation.target === companion)) return;
    refreshValidityStyles(document, companion);
  });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  installedDocuments.set(document, observer);
}

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
  installValidityStyles(el.ownerDocument);
  store.set(el, validity);
  const message = validity.valid ? "" : validity.errors[0]!.message;

  if (supportsSetCustomValidity(el)) {
    el.setCustomValidity(message); // "" clears it
  }

  if (validity.valid) {
    el.removeAttribute("aria-invalid");
    el.removeAttribute("data-invalid");
    el.removeAttribute("data-user-invalid");
    el.setAttribute("data-valid", "");
  } else {
    el.removeAttribute("data-valid");
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
  if (!validity.valid) el.setAttribute("data-user-invalid", "");
  return validity;
}
