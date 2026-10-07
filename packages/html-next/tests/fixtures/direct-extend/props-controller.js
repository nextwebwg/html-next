export default function initialize(host) {
  const log = globalThis.directExtendLog;
  const id = log.hosts.push(host) - 1;
  const note = (text) => log.events.push(`${id} ${text}`);
  note(`state ${Object.keys(host.props).filter((name) => name in host.state).join(",")}|${String(host.state[Object.keys(host.props)[0]])}`);
  host.effect(() => {
    note(`props ${Object.entries(host.props).map(([name, prop]) =>
      `${name}=${JSON.stringify(prop.value)}/${JSON.stringify(prop.inputValue)}/${prop.validity.valid}${prop.validity.errors.map((error) => `:${error.reason}`).join("")}`).join(" ")}`);
  });
  host.on("connect", () => {
    note(`connect ${host.root.getAttribute("data-valid") !== null} ${host.root.getAttribute("aria-invalid")} ${host.root.validity?.valid}`);
  });
}
