import type { Page } from "playwright";

interface DispatchStep {
  readonly button?: number;
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly child?: boolean;
  readonly count: number;
  readonly bubbled?: boolean;
  readonly prevented?: boolean;
}

interface ModifierCase {
  readonly id: string;
  readonly event: "click" | "keydown";
  readonly modifiers: string;
  readonly steps: readonly DispatchStep[];
  readonly definition?: string;
  readonly markup?: string;
}

const click = (button: number, count: number, extras: Partial<DispatchStep> = {}): DispatchStep => ({ button, count, ...extras });
const key = (value: string, count: number, extras: Partial<DispatchStep> = {}): DispatchStep => ({ key: value, count, ...extras });

export const cases: readonly ModifierCase[] = [
  { id: "stop", event: "click", modifiers: "stop", steps: [click(0, 1, { bubbled: false })] },
  { id: "prevent", event: "click", modifiers: "prevent", steps: [click(0, 1, { prevented: true })] },
  { id: "self_stop", event: "click", modifiers: "stop.self", steps: [click(0, 0, { child: true }), click(0, 1, { bubbled: false })] },
  { id: "once", event: "click", modifiers: "once", steps: [click(0, 1), click(0, 1)] },
  { id: "passive", event: "click", modifiers: "passive", steps: [click(0, 1)] },
  { id: "capture", event: "click", modifiers: "capture", steps: [click(0, 1, { child: true })] },
  { id: "capture_order", event: "click", modifiers: "capture", steps: [click(0, 11)],
    definition: '<state type="number" name="count_capture_order" value="0"></state><handler name="capture_capture_order"><set name="count_capture_order" expr:value="$count_capture_order + 1"></set></handler><handler name="bubble_capture_order"><set name="count_capture_order" expr:value="$count_capture_order * 10 + 1"></set></handler>',
    markup: '<div data-case="capture_order" on:click.capture="capture_capture_order"><button type="button" on:click="bubble_capture_order">capture_order</button><output $value="$count_capture_order"></output></div>',
  },
  { id: "capture_computed", event: "click", modifiers: "capture", steps: [click(0, 3)],
    definition: '<state type="number" name="count_capture_computed" value="0"></state><computed name="doubled_capture_computed" from="$count_capture_computed * 2"></computed><handler name="capture_capture_computed"><set name="count_capture_computed" expr:value="$count_capture_computed + 1"></set></handler><handler name="bubble_capture_computed"><set name="count_capture_computed" expr:value="$doubled_capture_computed + 1"></set></handler>',
    markup: '<div data-case="capture_computed" on:click.capture="capture_capture_computed"><button type="button" on:click="bubble_capture_computed">capture_computed</button><output $value="$count_capture_computed"></output></div>',
  },
  { id: "computed_steps", event: "click", modifiers: "stop", steps: [click(0, 3, { bubbled: false })],
    definition: '<state type="number" name="count_computed_steps" value="0"></state><computed name="doubled_computed_steps" from="$count_computed_steps * 2"></computed><handler name="hit_computed_steps"><set name="count_computed_steps" expr:value="$doubled_computed_steps + 1"></set><set name="count_computed_steps" expr:value="$doubled_computed_steps + 1"></set></handler>',
  },
  { id: "computed_chain", event: "click", modifiers: "stop", steps: [click(0, 3, { bubbled: false })],
    definition: '<state type="number" name="count_computed_chain" value="0"></state><computed name="doubled_computed_chain" from="$count_computed_chain * 2"></computed><computed name="next_computed_chain" from="$doubled_computed_chain + 1"></computed><handler name="hit_computed_chain"><set name="count_computed_chain" expr:value="$next_computed_chain"></set><set name="count_computed_chain" expr:value="$next_computed_chain"></set></handler>',
  },
  { id: "left_mouse", event: "click", modifiers: "left", steps: [click(2, 0), click(0, 1)] },
  { id: "middle_mouse", event: "click", modifiers: "middle", steps: [click(0, 0), click(1, 1)] },
  { id: "right_mouse", event: "click", modifiers: "right", steps: [click(0, 0), click(2, 1)] },
  { id: "ctrl", event: "keydown", modifiers: "ctrl", steps: [key("x", 0), key("x", 1, { ctrlKey: true })] },
  { id: "shift", event: "keydown", modifiers: "shift", steps: [key("x", 0), key("x", 1, { shiftKey: true })] },
  { id: "alt", event: "keydown", modifiers: "alt", steps: [key("x", 0), key("x", 1, { altKey: true })] },
  { id: "meta", event: "keydown", modifiers: "meta", steps: [key("x", 0), key("x", 1, { metaKey: true })] },
  { id: "exact", event: "keydown", modifiers: "ctrl.exact", steps: [key("x", 1, { ctrlKey: true }), key("x", 1, { ctrlKey: true, shiftKey: true })] },
  { id: "enter", event: "keydown", modifiers: "enter", steps: [key("Escape", 0), key("Enter", 1)] },
  { id: "escape", event: "keydown", modifiers: "escape", steps: [key("Enter", 0), key("Escape", 1)] },
  { id: "space", event: "keydown", modifiers: "space", steps: [key("Enter", 0), key(" ", 1)] },
  { id: "tab", event: "keydown", modifiers: "tab", steps: [key("Enter", 0), key("Tab", 1)] },
  { id: "up", event: "keydown", modifiers: "up", steps: [key("ArrowDown", 0), key("ArrowUp", 1)] },
  { id: "down", event: "keydown", modifiers: "down", steps: [key("ArrowUp", 0), key("ArrowDown", 1)] },
  { id: "left_key", event: "keydown", modifiers: "left", steps: [key("ArrowRight", 0), key("ArrowLeft", 1)] },
  { id: "right_key", event: "keydown", modifiers: "right", steps: [key("ArrowLeft", 0), key("ArrowRight", 1)] },
  { id: "once_enter", event: "keydown", modifiers: "enter.once", steps: [key("Escape", 0), key("Enter", 0)] },
  { id: "ctrl_enter_exact", event: "keydown", modifiers: "ctrl.enter.exact", steps: [key("Enter", 0), key("Escape", 0, { ctrlKey: true }), key("Enter", 0, { ctrlKey: true, shiftKey: true }), key("Enter", 1, { ctrlKey: true })] },
];

export const source = `<template component="x-event-matrix" status="early" summary="Event modifier parity."><defs>
${cases.map(({ id, definition }) => definition ?? `<state type="number" name="count_${id}" value="0"></state><handler name="hit_${id}"><set name="count_${id}" expr:value="$count_${id} + 1"></set></handler>`).join("\n")}
</defs><section>
${cases.map(({ id, event, modifiers, markup }) => markup ?? `<div data-case="${id}"><button type="button" on:${event}.${modifiers}="hit_${id}">${id}<span>child</span></button><output $value="$count_${id}"></output></div>`).join("\n")}
</section></template>`;

export type DispatchResult = { readonly bubbled: boolean; readonly prevented: boolean; readonly returned: boolean };

export async function runMatrix(page: Page): Promise<readonly (readonly DispatchResult[])[]> {
  return page.evaluate((scenarios) => {
    const bubbles = { count: 0 };
    document.addEventListener("click", () => { bubbles.count += 1; });
    document.addEventListener("keydown", () => { bubbles.count += 1; });
    return scenarios.map(({ id, event, steps }) => {
      const control = document.querySelector<HTMLButtonElement>(`#case [data-case="${id}"] button`)!;
      return steps.map((step) => {
        const target = step.child ? control.querySelector("span")! : control;
        const before = bubbles.count;
        const dispatched = event === "click"
          ? new MouseEvent("click", { bubbles: true, cancelable: true, button: step.button ?? 0 })
          : new KeyboardEvent("keydown", {
            bubbles: true, cancelable: true, key: step.key ?? "",
            ctrlKey: step.ctrlKey ?? false, shiftKey: step.shiftKey ?? false,
            altKey: step.altKey ?? false, metaKey: step.metaKey ?? false,
          });
        const returned = target.dispatchEvent(dispatched);
        return { bubbled: bubbles.count > before, prevented: dispatched.defaultPrevented, returned };
      });
    });
  }, cases);
}

export async function snapshot(page: Page): Promise<{ readonly counts: readonly string[]; readonly pixels: Buffer }> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return {
    counts: await page.locator("#case output").allTextContents(),
    pixels: await page.locator("#case").screenshot({ animations: "disabled" }),
  };
}
