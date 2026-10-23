// The module for <x-counter>. The definition names this module, so its named connect
// export needs no package import and does not repeat the component tag.
export function connect({ refs, state }, { signal }) {
  refs.btn.addEventListener("click", () => {
    // Drive STATE, never the DOM directly. The runtime reflects count to the <span>.
    state.count = state.count + 1;
  }, { signal });
}
