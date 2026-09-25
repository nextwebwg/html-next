import { markConnected } from "./overlay-helper.js";

export default function controller(host) {
  markConnected(host.root);
}
