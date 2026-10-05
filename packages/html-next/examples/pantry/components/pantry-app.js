// The controller for <pantry-app>. It owns what the template language deliberately cannot express:
// turning a fetched payload into rows, deriving counts, and applying the rows' events.
// It drives state only — never the DOM.
//
// The authoritative list lives here, in an ordinary variable. Declared state holds only what the
// template renders, so no effect ever writes a value it also reads.

export default function controller(host) {
  const { effect, data, state } = host;
  let pantry = [];

  const search = () => String(state.query ?? "").trim().toLowerCase();

  /** Publishes the rendered view of the list: `$where` filters on a value, not on an expression. */
  const publish = (needle = search()) => {
    const rows = pantry.map((row) => ({
      ...row,
      matches: needle === "" || row.label.toLowerCase().includes(needle),
    }));
    state.rows = rows;
    state.total = pantry.length;
    state.visible = rows.filter((row) => row.matches).length;
    state.lowCount = pantry.filter((row) => row.quantity <= row.threshold).length;
  };

  // The declared <data> request seeds the list; the search box reshapes it. Both inputs are read
  // here so this effect reruns for either, and it writes only state it does not read.
  let seeded = false;
  effect(() => {
    const request = data.stock;
    const needle = search();
    if (!seeded && request?.ok && Array.isArray(request.value)) {
      pantry = request.value.map((row) => ({ ...row }));
      seeded = true;
    }
    publish(needle);
  });

  const apply = (change) => {
    pantry = pantry.flatMap(change);
    publish();
  };

  const adjust = (event) => {
    const { id, delta } = event.detail;
    apply((row) => (row.id === id ? [{ ...row, quantity: Math.max(0, row.quantity + delta) }] : [row]));
  };
  host.on("adjust", adjust);

  const remove = (event) => {
    apply((row) => (row.id === event.detail ? [] : [row]));
  };
  host.on("remove", remove);

  // A catalog hit carries what the endpoint returned; stock and threshold are local decisions.
  const add = (event) => {
    const { id, label, unit } = event.detail;
    if (pantry.some((row) => row.id === id)) return;
    pantry = [...pantry, { id, label, quantity: 1, unit, threshold: 1 }];
    publish();
    state.catalogQuery = "";
  };
  host.on("add", add);

  // The add form is a native <form>: required, minlength, and min/max are the browser's job.
  host.on("connect", () => {
  const form = host.refs.addForm;
  const submit = (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const label = String(state.draftLabel ?? "").trim();
    if (label === "") return;
    pantry = [...pantry, {
      id: `local-${label.toLowerCase().replace(/\s+/g, "-")}`,
      label,
      quantity: Number(state.draftQuantity ?? 0),
      unit: "pcs",
      threshold: 1,
    }];
    publish();
    state.draftLabel = "";
    state.draftQuantity = 1;
  };
  form.addEventListener("submit", submit);

  return () => form.removeEventListener("submit", submit);
  });

  host.on("restock-request", () => apply((row) =>
    [row.quantity <= row.threshold ? { ...row, quantity: row.threshold + 1 } : row]));
}
