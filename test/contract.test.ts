import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineContract,
  serializePropTarget,
} from "../src/contract.js";
import { Html7DiagnosticError } from "../src/diagnostics.js";

// Deliberately loose: several tests mutate this fixture into invalid runtime data.
// `defineContract()` accepts unknown input and is responsible for narrowing it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validContract(): any {
  return {
    version: 1,
    name: "Button",
    tag: "looma-button",
    status: "early",
    summary: "A native button with Looma presentation.",
    nativeElement: "button",
    props: {
      variant: {
        type: { enum: ["outline", "solid", "destructive", "ghost"] },
        default: "outline",
        target: { attribute: "data-lm-variant" },
        description: "Visual treatment.",
      },
    },
  };
}

function expectDiagnostic(code: string, operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof Html7DiagnosticError);
    assert.equal(error.diagnostic.code, code);
    assert.equal(error.diagnostic.source, "button.html");
    assert.ok(error.diagnostic.message.length > 0);
    return true;
  });
}

function defineFromButtonFile(value: unknown) {
  return defineContract(value, { source: "button.html" });
}

describe("defineContract", () => {
  it("validates and normalizes a schema v1 component", () => {
    const contract = defineFromButtonFile(validContract());

    assert.deepEqual(contract, {
      version: 1,
      name: "Button",
      tag: "looma-button",
      status: "early",
      summary: "A native button with Looma presentation.",
      nativeElement: "button",
      props: {
        variant: {
          type: { enum: ["outline", "solid", "destructive", "ghost"] },
          required: false,
          default: "outline",
          target: { attribute: "data-lm-variant" },
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
        target: { attribute: "data-lm-variant" },
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

  it("rejects unknown fields at every schema object boundary", () => {
    expectDiagnostic("H7C002", () =>
      defineFromButtonFile({ ...validContract(), typo: true }),
    );

    const unknownProp = validContract();
    Object.assign(unknownProp.props.variant, { typo: true });
    expectDiagnostic("H7C002", () => defineFromButtonFile(unknownProp));

    const unknownType = validContract();
    unknownType.props.variant.type = {
      enum: ["outline", "solid"],
      typo: true,
    } as typeof unknownType.props.variant.type;
    expectDiagnostic("H7C002", () => defineFromButtonFile(unknownType));

    const unknownTarget = validContract();
    unknownTarget.props.variant.target = {
      attribute: "data-variant",
      typo: true,
    } as typeof unknownTarget.props.variant.target;
    expectDiagnostic("H7C002", () => defineFromButtonFile(unknownTarget));
  });

  it("rejects invalid component and prop names", () => {
    for (const patch of [
      { name: "button" },
      { name: "Button-name" },
      { tag: "button" },
      { tag: "Looma-button" },
      { nativeElement: "bad element" },
    ]) {
      expectDiagnostic(
        patch.name === "button" || patch.name === "Button-name"
          ? "H7C004"
          : patch.tag
            ? "H7C005"
            : "H7C008",
        () => defineFromButtonFile({ ...validContract(), ...patch }),
      );
    }

    const invalidProp = validContract();
    invalidProp.props = {
      "1variant": invalidProp.props.variant,
    };
    expectDiagnostic("H7C010", () => defineFromButtonFile(invalidProp));
  });

  it("requires known native elements and canonical property targets", () => {
    expectDiagnostic("H7C008", () =>
      defineFromButtonFile({ ...validContract(), nativeElement: "not-a-native-element" }),
    );

    const canonical = validContract();
    canonical.props = {
      action: {
        type: "string",
        target: { property: "formaction" },
        description: "Submission destination.",
      },
    };
    assert.equal(defineFromButtonFile(canonical).props.action?.target.property, "formAction");

    const unknownProperty = validContract();
    unknownProperty.props = {
      action: {
        type: "string",
        target: { property: "notAButtonProperty" },
        description: "Invalid destination.",
      },
    };
    expectDiagnostic("H7P001", () => defineFromButtonFile(unknownProperty));
  });

  it("rejects invalid types, defaults, required flags, and targets", () => {
    const cases: Array<[string, (input: ReturnType<typeof validContract>) => void]> = [
      ["H7C013", (input) => { input.props.variant.type = "date" as never; }],
      ["H7C014", (input) => { input.props.variant.type = { enum: [] }; }],
      ["H7C014", (input) => { input.props.variant.type = { enum: ["a", "a"] }; }],
      ["H7C015", (input) => { input.props.variant.default = "missing"; }],
      ["H7C016", (input) => { input.props.variant.required = "yes" as never; }],
      ["H7C019", (input) => { input.props.variant.required = true; }],
      ["H7C017", (input) => { input.props.variant.target = {} as never; }],
      ["H7C017", (input) => {
        input.props.variant.target = {
          attribute: "data-variant",
          property: "value",
        } as never;
      }],
      ["H7C017", (input) => {
        input.props.variant.target = { attribute: "bad name" };
      }],
      ["H7C017", (input) => {
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

    expectDiagnostic("H7C011", () => defineFromButtonFile(input));
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
        Object.isFrozen(contract.props.variant.type.enum),
    );

    assert.throws(() => {
      (contract.props.variant as { required: boolean }).required = true;
    }, TypeError);
    assert.throws(() => {
      (contract.props.variant?.type as { enum: string[] }).enum.push("new");
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
      tag: "looma-button",
      name: "Button",
      version: 1,
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
      name: "data-lm-variant",
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
        error instanceof Html7DiagnosticError &&
        error.diagnostic.code === "H7C021",
    );
    assert.throws(
      () => serializePropTarget(contract.props.disabled!, undefined),
      (error: unknown) =>
        error instanceof Html7DiagnosticError &&
        error.diagnostic.code === "H7C020",
    );
  });
});
