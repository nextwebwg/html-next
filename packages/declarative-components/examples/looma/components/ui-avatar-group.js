export default function controller(host) {
  let overflow;
  const apply = () => {
    const children = Array.from(host.element.children).filter((child) => child !== overflow);
    const limit = Math.max(0, Math.floor(host.state.max));
    children.forEach((child, index) => { child.hidden = index >= limit; });
    const count = Math.max(0, children.length - limit);
    if (count === 0) { overflow?.remove(); overflow = undefined; return; }
    overflow ||= host.element.ownerDocument.createElement("span");
    overflow.className = "overflow";
    overflow.setAttribute("role", "img");
    overflow.setAttribute("data-ui-avatar-group-overflow", "");
    overflow.setAttribute("aria-label", count + " more " + (count === 1 ? "person" : "people"));
    overflow.textContent = "+" + count;
    if (!overflow.isConnected) host.element.append(overflow);
  };
  const stop = host.effect(apply);
  const observer = new MutationObserver((records) => {
    if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => node !== overflow))) apply();
  });
  observer.observe(host.element, { childList: true });
  return () => { stop(); observer.disconnect(); overflow?.remove(); };
}
