function initials(value) {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "?";
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return (tokens[0][0] + tokens[1][0]).toUpperCase();
}

export default function controller(host) {
  const image = host.refs.image;
  const fallback = host.refs.fallback;
  let loaded = false;
  let source;
  const render = () => {
    const label = host.state.alt || host.state.name || "Avatar";
    host.element.setAttribute("aria-label", label);
    fallback.textContent = host.state.fallback || initials(host.state.name || host.state.alt);
    image.hidden = !loaded;
    image.setAttribute("aria-hidden", String(!loaded));
    fallback.hidden = loaded;
    fallback.setAttribute("aria-hidden", String(loaded));
    host.element.toggleAttribute("data-has-image", loaded);
  };
  const stop = host.effect(() => {
    if (source !== host.state.src) {
      source = host.state.src;
      loaded = false;
      image.src = source;
    }
    render();
  });
  const load = () => { loaded = true; render(); };
  const error = () => { loaded = false; render(); };
  image.addEventListener("load", load);
  image.addEventListener("error", error);
  return () => { stop(); image.removeEventListener("load", load); image.removeEventListener("error", error); };
}
