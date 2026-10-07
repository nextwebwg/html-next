const adjectives = [
  "pretty", "large", "big", "small", "tall", "short", "long", "handsome", "plain",
  "quaint", "clean", "elegant", "easy", "angry", "crazy", "helpful", "mushy", "odd",
  "unsightly", "adorable", "important", "inexpensive", "cheap", "expensive", "fancy",
];
const colours = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"];
const nouns = ["table", "chair", "house", "bbq", "desk", "car", "pony", "cookie", "sandwich", "burger", "pizza", "mouse", "keyboard"];

const random = (maximum) => Math.round(Math.random() * 1000) % maximum;

export default function initialize(host) {
  host.state.selected = null;
  let nextId = 1;
  const buildData = (count = 1000) => {
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      rows.push({
        id: nextId++,
        label: `${adjectives[random(adjectives.length)]} ${colours[random(colours.length)]} ${nouns[random(nouns.length)]}`,
      });
    }
    return rows;
  };

  const resetSelection = () => { host.state.selected = null; };
  const actions = {
    run() {
      host.state.rows = buildData();
      resetSelection();
    },
    runlots() {
      host.state.rows = buildData(10000);
      resetSelection();
    },
    add() {
      host.state.rows = host.state.rows.concat(buildData());
      resetSelection();
    },
    update() {
      const rows = host.state.rows;
      for (let index = 0; index < rows.length; index += 10) rows[index].label += " !!!";
      resetSelection();
    },
    clear() {
      host.state.rows = [];
      resetSelection();
    },
    swaprows() {
      const rows = host.state.rows;
      if (rows.length <= 998) return;
      const second = rows[1];
      rows[1] = rows[998];
      rows[998] = second;
    },
  };

  host.on("connect", () => {
    const stop = host.on("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("button, a") : null;
      if (target === null || !host.root.contains(target)) return;
      if (target instanceof HTMLButtonElement) {
        actions[target.id]?.();
        return;
      }
      const id = Number(target.closest("tr")?.dataset.id);
      if (!Number.isFinite(id)) return;
      if (target.dataset.action === "select") host.state.selected = id;
      if (target.dataset.action === "remove") {
        host.state.rows = host.state.rows.filter((row) => row.id !== id);
      }
    });

    host.state.ready = true;
    return stop;
  });
}
