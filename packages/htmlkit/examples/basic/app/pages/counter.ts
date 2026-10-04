export default function(host) {
  const click = () => { host.state.count += 1; };
  host.refs.increment.addEventListener("click", click);
  return () => host.refs.increment.removeEventListener("click", click);
}
