// The controller for <x-counter>. The definition names this module, so its default
// export needs no package import and does not repeat the component tag.
export default function controller(host) {
  host.refs.btn.addEventListener("click", () => {
    // Drive STATE, never the DOM directly. The runtime reflects count to the <span>.
    host.state.count = host.state.count + 1;
  });
}
