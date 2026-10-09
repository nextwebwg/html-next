// Records the host and each effect run, so a parity step can tell which readers ran again.
export default function initialize(host) {
  const log = globalThis.directExtendLog;
  log.hosts.push(host);
  host.effect(() => { log.events.push(`effect first ${host.state.items[0].name}`); });
  host.effect(() => { log.events.push(`effect sum ${host.state.sum}`); });
  host.effect(() => { log.events.push(`effect label ${host.state.label}`); });
}
