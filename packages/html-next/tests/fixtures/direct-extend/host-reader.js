// Records the component's host, so a parity step can read it.
export default function initialize(host) {
  globalThis.directExtendLog.hosts.push(host);
}
