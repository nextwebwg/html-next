// Reference reader for the draft-2 rendered form. It recovers the authored invocation from markup plus
// the component definitions in the document. Accepts ProcessingInstruction nodes and, in engines that
// do not parse PIs, the comments they become.
(() => {
  const RECORD = new Set(["data-component", "data-component-root", "data-slotted"]);
  const piParsing = (() => {
    const probe = document.createElement("div");
    probe.setHTMLUnsafe("<?probe x=\"1\"?>");
    return probe.firstChild?.nodeType === 7;
  })();

  // xml-stylesheet "rules for parsing pseudo-attributes": Name S? = S? quoted value, no duplicates;
  // any error is an error for the whole string (DOM: the attribute map stays empty).
  const REFERENCES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  function pseudoAttributes(data) {
    const attributes = new Map();
    let rest = data.trim();
    while (rest !== "") {
      const match = /^([A-Za-z_:][-A-Za-z0-9._:]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')(?:\s+|$)/.exec(rest);
      if (!match) return null;
      const raw = match[2] ?? match[3];
      let value = "";
      for (const part of raw.split(/(&[^;]*;)/)) {
        if (!part.startsWith("&")) { value += part; continue; }
        const body = part.slice(1, -1);
        if (body in REFERENCES) value += REFERENCES[body];
        else if (/^#\d+$/.test(body)) value += String.fromCodePoint(Number(body.slice(1)));
        else if (/^#x[0-9a-fA-F]+$/.test(body)) value += String.fromCodePoint(parseInt(body.slice(2), 16));
        else return null;
      }
      if (attributes.has(match[1])) return null;
      attributes.set(match[1], value);
      rest = rest.slice(match[0].length);
    }
    return attributes;
  }

  // One node -> { target, attributes } when it is a processing instruction (or, without PI parsing, the
  // comment an older parser made of one).
  function instruction(node) {
    if (node.nodeType === 7) {
      return { target: node.target, attributes: pseudoAttributes(node.data) ?? new Map() };
    }
    if (node.nodeType !== 8 || piParsing) return null;
    const match = /^\?([A-Za-z][-A-Za-z0-9]*)(?:\s+([\s\S]*?))?\s*\??$/.exec(node.data);
    if (!match) return null;
    return { target: match[1], attributes: pseudoAttributes(match[2] ?? "") ?? new Map() };
  }
  const isStart = (i) => i?.target === "start";
  const isEnd = (i) => i?.target === "end";
  const slotOf = (i) => (i && i.attributes.has("slot") ? i.attributes.get("slot") : null);

  // Walk a sibling list in a root's own region. Every start/end pair nests (a page's partial-update
  // ranges included); only pairs whose start carries `slot` are component slot ranges.
  function collect(nodes, ranges, lineageRoot) {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const mark = instruction(node);
      if (mark?.target === "marker" && slotOf(mark) !== null) {
        ranges.push({ slot: slotOf(mark), fallback: false, nodes: [] });
        continue;
      }
      if (isStart(mark)) {
        let depth = 1; const content = [];
        for (index += 1; index < nodes.length; index += 1) {
          const inner = instruction(nodes[index]);
          if (isStart(inner)) depth += 1;
          else if (isEnd(inner) && --depth === 0) break;
          content.push(nodes[index]);
        }
        if (slotOf(mark) !== null) ranges.push({ slot: slotOf(mark), fallback: mark.attributes.has("fallback"), nodes: content });
        else collect(content, ranges, lineageRoot);   // a page's own range: transparent
        continue;
      }
      if (node.nodeType !== 1) continue;
      if (node !== lineageRoot && node.hasAttribute("data-component-root")) {
        // A nested root: what this root projected into it is inside the nested root's ranges.
        for (const range of rangesOf(node, 0)) collect(range.nodes, ranges, lineageRoot);
      } else collect([...node.childNodes], ranges, lineageRoot);
    }
    return ranges;
  }

  // A root element can carry several lineages (delegation: outermost first). The innermost component
  // renders the element's children; each outer component's ranges sit inside the next inner one's.
  function lineage(root) { return root.getAttribute("data-component-root").trim().split(/\s+/); }
  function rangesOf(root, level) {
    const tags = lineage(root);
    if (level === tags.length - 1) return collect([...root.childNodes], [], root);
    const ranges = [];
    for (const range of rangesOf(root, level + 1)) collect(range.nodes, ranges, root);
    return ranges;
  }

  // Definitions are read when the reader loads: the runtime consumes <template component> on registration.
  const definitions = new Map([...document.querySelectorAll("template[component]")].map((template) => [
    template.getAttribute("component"),
    {
      props: [...template.content.querySelectorAll("defs > prop")].map((p) => p.getAttribute("name")),
      hasSlots: !!template.content.querySelector("slot"),
    },
  ]));
  const definition = (tag) => definitions.get(tag) ?? { props: [], hasSlots: false };
  const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const escapeText = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const escapeAttr = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  function authored(node) {
    if (node.nodeType === 3) return escapeText(node.data);
    if (node.nodeType === 8) return `<!--${node.data}-->`;
    if (node.nodeType === 7) return `<?${node.target}${node.data ? ` ${node.data}` : ""}?>`;
    if (node.nodeType !== 1) return "";
    if (node.hasAttribute("data-component-root")) return invocation(node, 0);
    const attrs = [...node.attributes].filter((a) => !RECORD.has(a.name));
    return `<${node.localName}${attrs.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join("")}>${[...node.childNodes].map(authored).join("")}</${node.localName}>`;
  }
  function invocation(root, level) {
    const tag = lineage(root)[level];
    const { props, hasSlots } = definition(tag);
    const ranges = rangesOf(root, level);
    if (hasSlots && ranges.length === 0) {
      throw new Error(`HR005: <${tag}> declares slots but its rendered form has no slot markers (stripped?).`);
    }
    const attrs = props.map((prop) => [kebab(prop), root.getAttribute(`data-${kebab(prop)}`)]).filter(([, v]) => v !== null);
    const children = ranges.filter((r) => !r.fallback).flatMap((r) => r.nodes);
    return `<${tag}${attrs.map(([n, v]) => ` ${n}="${escapeAttr(v)}"`).join("")}>${children.map(authored).join("")}</${tag}>`;
  }

  window.RenderedForm = { recover: (container) => [...container.childNodes].map(authored).join(""), pseudoAttributes, piParsing };
})();
