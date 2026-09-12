import { Component, h } from "@stencil/core";

@Component({ tag: "ui-example", styleUrl: "ui-example.css", shadow: true })
export class UiExample {
  render() {
    return <label><input onKeyDown={() => undefined}/><slot name="label"/><slot name={`item-${1}`}/></label>;
  }
}
