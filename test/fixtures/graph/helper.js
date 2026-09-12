export function setup(element) {
  element.dataset.connected = "true";
  return () => element.removeAttribute("data-connected");
}
