import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  defineContract,
  serializePropTarget,
} from "../src/contract.js";
import { HtmlDiagnosticError } from "../src/diagnostics.js";

// Deliberately loose: several tests mutate this fixture into invalid runtime data.
// `defineContract()` accepts unknown input and is responsible for narrowing it. The
// `component` tag arrives separately (from the carrier attribute), so it is not a field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validContract(): any {
  return {
    status: "early",
    summary: "A native button.",
    nativeElement: "button",
    props: {
      variant: {
        type: { enum: ["outline", "solid", "destructive", "ghost"] },
        default: "outline",
        target: { attribute: "data-variant" },
        description: "Visual treatment.",
      },
    },
  };
}

function expectDiagnostic(code: string, operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof HtmlDiagnosticError);
    assert.equal(error.diagnostic.code, code);
    assert.equal(error.diagnostic.source, "button.html");
    assert.ok(error.diagnostic.message.length > 0);
    return true;
  });
}

function defineWithTag(value: unknown, tag: string) {
  return defineContract(value, { source: "button.html", tag });
}

function defineFromButtonFile(value: unknown) {
  return defineWithTag(value, "x-button");
}

describe("defineContract", () => {
  it("validates and normalizes a component, deriving the name from the tag", () => {
    const contract = defineFromButtonFile(validContract());

    assert.deepEqual(contract, {
      version: 1,
      name: "XButton",
      tag: "x-button",
      status: "early",
      summary: "A native button.",
      nativeElement: "button",
      props: {
        variant: {
          type: { enum: ["outline", "solid", "destructive", "ghost"] },
          required: false,
          default: "outline",
          target: { attribute: "data-variant" },
          description: "Visual treatment.",
        },
      },
    });
  });

  it("handles scalar, enum, default, and required prop contracts", () => {
    const input = validContract();
    input.props = {
      title: {
        type: "string",
        default: "Save",
        target: { attribute: "title" },
        description: "Accessible title.",
      },
      disabled: {
        type: "boolean",
        required: true,
        target: { property: "disabled" },
        description: "Disabled state.",
      },
      order: {
        type: "number",
        default: 2,
        target: { attribute: "data-order" },
        description: "Display order.",
      },
      variant: {
        type: { enum: ["outline", "solid"] },
        default: "outline",
        target: { attribute: "data-variant" },
        description: "Visual treatment.",
      },
    } as typeof input.props;

    const contract = defineFromButtonFile(input);

    assert.deepEqual(Object.keys(contract.props), [
      "disabled",
      "order",
      "title",
      "variant",
    ]);
    assert.equal(contract.props.disabled?.required, true);
    assert.equal(contract.props.title?.required, false);
    assert.equal(contract.props.order?.default, 2);
    assert.deepEqual(contract.props.variant?.type, {
      enum: ["outline", "solid"],
    });
  });

  it("requires callbacks and opaque values to target properties", () => {
    const input = validContract();
    input.props = {
      provider: {
        type: "function",
        target: { property: "provider" },
        description: "Loads values.",
      },
    };
    assert.equal(defineFromButtonFile(input).props.provider?.target.property, "provider");
    input.props.provider.target = { attribute: "provider" };
    expectDiagnostic("HC017", () => defineFromButtonFile(input));
  });

  it("rejects unknown fields at every schema object boundary", () => {
    expectDiagnostic("HC002", () =>
      defineFromButtonFile({ ...validContract(), typo: true }),
    );

    const unknownProp = validContract();
    Object.assign(unknownProp.props.variant, { typo: true });
    expectDiagnostic("HC002", () => defineFromButtonFile(unknownProp));

    const unknownType = validContract();
    unknownType.props.variant.type = {
      enum: ["outline", "solid"],
      typo: true,
    } as typeof unknownType.props.variant.type;
    expectDiagnostic("HC002", () => defineFromButtonFile(unknownType));

    const unknownTarget = validContract();
    unknownTarget.props.variant.target = {
      attribute: "data-variant",
      typo: true,
    } as typeof unknownTarget.props.variant.target;
    expectDiagnostic("HC002", () => defineFromButtonFile(unknownTarget));
  });

  it("rejects invalid tags, native elements, and prop names", () => {
    for (const tag of ["button", "Looma-button"]) {
      expectDiagnostic("HC005", () => defineWithTag(validContract(), tag));
    }
    expectDiagnostic("HC008", () =>
      defineFromButtonFile({ ...validContract(), nativeElement: "bad element" }),
    );
    expectDiagnostic("HC008", () =>
      defineFromButtonFile({ ...validContract(), nativeElement: "notanativeelement" }),
    );

    const invalidProp = validContract();
    invalidProp.props = {
      "1variant": invalidProp.props.variant,
    };
    expectDiagnostic("HC010", () => defineFromButtonFile(invalidProp));
  });

  it("rejects invalid types, defaults, required flags, and targets", () => {
    const cases: Array<[string, (input: ReturnType<typeof validContract>) => void]> = [
      ["HC013", (input) => { input.props.variant.type = "list(" as never; }],
      ["HC014", (input) => { input.props.variant.type = { enum: [] }; }],
      ["HC014", (input) => { input.props.variant.type = { enum: ["a", "a"] }; }],
      ["HC015", (input) => { input.props.variant.default = "missing"; }],
      ["HC016", (input) => { input.props.variant.required = "yes" as never; }],
      ["HC019", (input) => { input.props.variant.required = true; }],
      ["HC017", (input) => { input.props.variant.target = {} as never; }],
      ["HC017", (input) => {
        input.props.variant.target = {
          attribute: "data-variant",
          property: "value",
        } as never;
      }],
      ["HC017", (input) => {
        input.props.variant.target = { attribute: "bad name" };
      }],
      ["HC017", (input) => {
        input.props.variant.target = { property: "bad-name" } as never;
      }],
    ];

    for (const [code, mutate] of cases) {
      const input = validContract();
      mutate(input);
      expectDiagnostic(code, () => defineFromButtonFile(input));
    }
  });

  it("rejects case-insensitive prop collisions", () => {
    const input = validContract();
    input.props = {
      variant: input.props.variant,
      Variant: {
        ...input.props.variant,
        target: { attribute: "data-other-variant" },
      },
    };

    expectDiagnostic("HC011", () => defineFromButtonFile(input));
  });

  it("returns deeply immutable normalized data", () => {
    const contract = defineFromButtonFile(validContract());

    assert.ok(Object.isFrozen(contract));
    assert.ok(Object.isFrozen(contract.props));
    assert.ok(Object.isFrozen(contract.props.variant));
    assert.ok(Object.isFrozen(contract.props.variant?.target));
    assert.ok(Object.isFrozen(contract.props.variant?.type));
    assert.ok(
      typeof contract.props.variant?.type === "object" &&
        "enum" in contract.props.variant.type &&
        Object.isFrozen(contract.props.variant.type.enum),
    );

    assert.throws(() => {
      (contract.props.variant as { required: boolean }).required = true;
    }, TypeError);
    assert.throws(() => {
      const variant = contract.props.variant;
      assert.ok(variant !== undefined);
      (variant.type as { enum: string[] }).enum.push("new");
    }, TypeError);
  });

  it("normalizes deterministically regardless of input insertion order", () => {
    const first = validContract();
    first.props = {
      zebra: {
        type: "boolean",
        target: { attribute: "DATA-ZEBRA" },
        description: "Zebra flag.",
      },
      alpha: {
        description: "Alpha text.",
        target: { attribute: "TITLE" },
        type: "string",
      },
    } as typeof first.props;

    const second = {
      props: {
        alpha: {
          type: "string",
          target: { attribute: "TITLE" },
          description: "Alpha text.",
        },
        zebra: {
          description: "Zebra flag.",
          target: { attribute: "DATA-ZEBRA" },
          type: "boolean",
        },
      },
      nativeElement: "button",
      summary: first.summary,
      status: "early",
    };

    const normalizedFirst = defineFromButtonFile(first);
    const normalizedSecond = defineFromButtonFile(second);

    assert.equal(JSON.stringify(normalizedFirst), JSON.stringify(normalizedSecond));
    assert.equal(
      normalizedFirst.props.zebra?.target.attribute,
      "data-zebra",
    );
    assert.equal(normalizedFirst.props.alpha?.target.attribute, "title");
  });
});

describe("serializePropTarget", () => {
  it("serializes scalar, enum, default, boolean, and omitted values", () => {
    const contract = defineFromButtonFile({
      ...validContract(),
      props: {
        enabled: {
          type: "boolean",
          target: { attribute: "data-enabled" },
          description: "Enabled state.",
        },
        count: {
          type: "number",
          target: { attribute: "data-count" },
          description: "Item count.",
        },
        action: {
          type: "string",
          target: { property: "formAction" },
          description: "Submission destination.",
        },
        variant: validContract().props.variant,
        disabled: {
          type: "boolean",
          required: true,
          target: { property: "disabled" },
          description: "Disabled state.",
        },
      },
    });

    assert.deepEqual(serializePropTarget(contract.props.variant!, undefined), {
      kind: "attribute",
      name: "data-variant",
      value: "outline",
    });
    assert.deepEqual(serializePropTarget(contract.props.enabled!, true), {
      kind: "attribute",
      name: "data-enabled",
      value: "",
    });
    assert.deepEqual(serializePropTarget(contract.props.enabled!, false), {
      kind: "attribute",
      name: "data-enabled",
      value: null,
    });
    assert.deepEqual(serializePropTarget(contract.props.count!, 2.5), {
      kind: "attribute",
      name: "data-count",
      value: "2.5",
    });
    assert.deepEqual(serializePropTarget(contract.props.disabled!, true), {
      kind: "property",
      name: "disabled",
      value: true,
    });
    assert.deepEqual(serializePropTarget(contract.props.enabled!, undefined), {
      kind: "attribute",
      name: "data-enabled",
      value: null,
    });
    assert.deepEqual(serializePropTarget(contract.props.enabled!, null), {
      kind: "attribute",
      name: "data-enabled",
      value: null,
    });
    assert.deepEqual(serializePropTarget(contract.props.action!, null), {
      kind: "property",
      name: "formAction",
      value: null,
    });
    assert.throws(
      () => serializePropTarget(contract.props.disabled!, null),
      (error: unknown) =>
        error instanceof HtmlDiagnosticError &&
        error.diagnostic.code === "HC021",
    );
    assert.throws(
      () => serializePropTarget(contract.props.disabled!, undefined),
      (error: unknown) =>
        error instanceof HtmlDiagnosticError &&
        error.diagnostic.code === "HC020",
    );
  });
});
