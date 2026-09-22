// The controller for <x-chart>. Integrates a foreign "library" through a $ref, and an
// effect that re-runs if the reactive data changes.
// A stand-in for a real charting library (Chart.js, D3, …): draws bars into a canvas.
function draw(canvas, bars) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#e8501f";
  bars.forEach((h, i) => ctx.fillRect(i * 42 + 8, canvas.height - h * 10, 32, h * 10));
}

export default function controller({ effect, refs, state }) {
  // The library owns the canvas (its own, unbound subtree). The effect re-runs if
  // state.bars changes; here it simply draws once.
  effect(() => draw(refs.surface, state.bars));
}
