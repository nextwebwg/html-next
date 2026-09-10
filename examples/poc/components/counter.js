// The controller for <x-counter>. An ordinary ES module that self-registers by tag.
import { defineController } from "../poc.js";

export const controller = (host) => {
  host.refs.btn.addEventListener("click", () => {
    // Drive STATE, never the DOM directly. The runtime reflects count to the <span>.
    host.state.count = host.state.count + 1;
  });
};

// The explicit registration call, shaped like customElements.define(tag, class).
// Running this (on import) registers the controller and upgrades connected <x-counter>s.
defineController("x-counter", controller);
