export namespace Components {
  /** Example control. */
  interface UiExample {
    /** Controlled value. */
    "value"?: string;
    /** @default '' */
    "defaultValue": string;
    /** Focus it. */
    "focusInput": () => Promise<void>;
  }
}
declare namespace LocalJSX {
  interface UiExample {
    "onValue-change"?: (event: UiExampleCustomEvent<{ value: string }>) => void;
  }
}
