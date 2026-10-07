export default function initialize(host) {
  const log = globalThis.directExtendLog;
  const id = log.hosts.push(host) - 1;
  const note = (text) => log.events.push(`${id} ${text}`);
  const names = ["default", "head", "tail", "missing"];
  note(`slots ${names.map((name) => `${name}:${host.slots[name].length}:${name in host.slots}:${host.slots[name].map((element) => element.localName).join("+")}`).join(" ")}`);
  host.on("connect", () => { host.state.open = true; });
}
