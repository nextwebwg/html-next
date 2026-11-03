import type { GeneratedArtifact } from "../generate.js";
import { nativeControlModule } from "./react-control.js";

/** Angular lifecycle around the native setters, reset defaults and hydration snapshots used by other targets. */
export function angularControlArtifact(version: string): GeneratedArtifact {
  return { path: "angular/control.ts", content: `${nativeControlModule(version)}
import { Directive, ElementRef, Input, PLATFORM_ID, inject } from "@angular/core";
interface ControlBinding {
  readonly name: "value" | "checked";
  readonly value: unknown;
  readonly defaults: BoundDefaults;
  readonly update?: (value: unknown) => unknown;
}
@Directive({ selector: "[hnNextControl]", standalone: true })
export class HtmlNextControl {
  @Input("hnNextControl") bindings: readonly ControlBinding[] = [];
  private readonly element = inject<ElementRef<Element>>(ElementRef).nativeElement;
  private readonly browser = inject(PLATFORM_ID) === "browser";
  private attached = false;
  private readonly stops: (() => void)[] = [];
  private options: readonly HTMLOptionElement[] = [];
  ngAfterViewChecked(): void {
    const element = this.element;
    if (!this.browser) {
      for (const binding of this.bindings) {
        if (binding.name === "checked") { if (binding.value) element.setAttribute("checked", ""); else element.removeAttribute("checked"); }
        else if (element.localName === "textarea") element.textContent = binding.value == null ? "" : String(binding.value);
        else if (element.localName === "select") {
          const selected = new Set((Array.isArray(binding.value) ? binding.value : [binding.value]).map(String));
          for (const option of Array.from(element.querySelectorAll("option"))) {
            if (selected.has(option.getAttribute("value") ?? option.textContent ?? "")) option.setAttribute("selected", ""); else option.removeAttribute("selected");
          }
        } else element.setAttribute("value", binding.value == null ? "" : String(binding.value));
      }
      return;
    }
    const options = element instanceof HTMLSelectElement ? Array.from(element.options) : [];
    const changedOptions = options.length !== this.options.length || options.some((option, index) => option !== this.options[index]);
    this.options = options;
    for (const [index, binding] of this.bindings.entries()) {
      if (!this.attached) {
        const stop = attachBoundControl(element, binding.name, binding.value, binding.defaults,
          binding.update === undefined ? undefined : value => this.bindings[index]?.update?.(value));
        if (stop !== undefined) this.stops.push(stop);
      } else syncBoundControl(element, binding.name, binding.value, binding.defaults, false, true, changedOptions);
    }
    if (this.bindings.length > 0) this.attached = true;
  }
  ngOnDestroy(): void { for (const stop of this.stops) stop(); }
}
` };
}
