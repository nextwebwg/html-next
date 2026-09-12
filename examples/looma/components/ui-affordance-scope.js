import { createProximityCoordinator } from "./overlay.js";
export default function controller(host) {
  let coordinator;
  const stop = host.effect(() => {
    coordinator?.destroy();
    coordinator = createProximityCoordinator(host.element, host.state.nearRadius);
  });
  const observer = new MutationObserver(() => coordinator?.refresh());
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); coordinator?.destroy(); };
}
