export function connect(host) {
  return host.effect(() => {
    const button = host.refs.increment;
    const increment = () => { host.state.count += 1; };
    button.addEventListener("click", increment);
    return () => button.removeEventListener("click", increment);
  });
}
