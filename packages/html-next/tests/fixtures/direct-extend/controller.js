export default function initialize(host) {
  const log = globalThis.directExtendLog;
  log.hosts.push(host);
  host.on("connect", () => {
    log.events.push("connect");
    host.state.ready = true;
    return () => log.events.push("connect cleanup");
  });
  host.on("disconnect", () => log.events.push("disconnect"));
  host.effect(() => { log.events.push(`effect ${host.state.rows.length}`); });
  return () => log.events.push("cleanup");
}
