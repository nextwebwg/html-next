function triggerWidth(host, value, trigger) {
  const min = Math.max(1, Number(host.state.minWidth) || 176);
  const max = Math.max(min, Number(host.state.maxWidth) || 480);
  const width = Math.round(Math.max(min, Math.min(max, value)));
  host.element.style.setProperty("--ui-sidebar-width", width + "px");
  host.refs.handle.setAttribute("aria-valuemin", String(min));
  host.refs.handle.setAttribute("aria-valuemax", String(max));
  host.refs.handle.setAttribute("aria-valuenow", String(width));
  host.dispatch("resize", { width, trigger });
  if (host.state.storageKey) {
    try { localStorage.setItem("looma:sidebar-width:" + host.state.storageKey, String(width)); } catch {}
  }
}

export default function controller(host) {
  const handle = host.refs.handle;
  let pointer;
  const defaultWidth = () => host.state.width === "narrow" ? 224 : host.state.width === "wide" ? 384 : 288;
  const currentWidth = () => Number.parseFloat(host.element.style.getPropertyValue("--ui-sidebar-width")) || defaultWidth();
  const sync = () => {
    handle.hidden = !host.state.resizable;
    handle.setAttribute("aria-label", host.state.resizeLabel);
    if (!host.state.resizable) return;
    let stored;
    if (host.state.storageKey) {
      try { stored = Number(localStorage.getItem("looma:sidebar-width:" + host.state.storageKey)); } catch {}
    }
    triggerWidth(host, Number.isFinite(stored) && stored > 0 ? stored : currentWidth(), "programmatic");
  };
  const stop = host.effect(sync);
  const keydown = (event) => {
    const step = Math.max(1, Number(host.state.resizeStep) || 16);
    const multiplier = host.state.side === "end" ? -1 : 1;
    const next = event.key === "Home" ? host.state.minWidth : event.key === "End" ? host.state.maxWidth
      : event.key === "ArrowLeft" ? currentWidth() - step * multiplier
      : event.key === "ArrowRight" ? currentWidth() + step * multiplier : undefined;
    if (next === undefined) return;
    event.preventDefault();
    triggerWidth(host, next, "keyboard");
  };
  const pointerdown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointer?.abort();
    pointer = new AbortController();
    const startX = event.clientX;
    const startWidth = currentWidth();
    const multiplier = host.state.side === "end" ? -1 : 1;
    window.addEventListener("pointermove", (move) => triggerWidth(host, startWidth + (move.clientX - startX) * multiplier, "pointer"), { signal: pointer.signal });
    window.addEventListener("pointerup", () => pointer?.abort(), { once: true, signal: pointer.signal });
    window.addEventListener("pointercancel", () => pointer?.abort(), { once: true, signal: pointer.signal });
  };
  handle.addEventListener("keydown", keydown);
  handle.addEventListener("pointerdown", pointerdown);
  return () => { stop(); pointer?.abort(); handle.removeEventListener("keydown", keydown); handle.removeEventListener("pointerdown", pointerdown); };
}
