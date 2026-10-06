export default function initialize(host) {
  const log = globalThis.directExtendLog;
  const id = log.hosts.push(host) - 1;
  const note = (text) => log.events.push(`${id} ${text}`);
  host.on("connect", () => {
    note("connect");
    host.state.ready = true;
    return () => note("connect cleanup");
  });
  host.on("disconnect", () => note("disconnect"));
  host.on("click", (event) => note(`click ${event.target.localName}`));
  // Controller effects run after the template job, so they see the rendered DOM.
  host.effect(() => { note(`effect ${host.state.rows.length} ${host.root.querySelectorAll("li").length}`); });
  const doubled = host.computed(() => host.state.rows.length * 2);
  host.effect(() => { note(`selected ${host.state.selected} ${doubled.get()} ${host.root.querySelector("p").textContent}`); });
  if (globalThis.directExtendLate) return new Promise((resolve) => setTimeout(() => resolve(() => note("late cleanup")), 0));
  return () => note("cleanup");
}
