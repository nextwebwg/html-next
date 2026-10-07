/**
 * The rendered form's marks (slot ranges, carried projection). The live runtime and compiled
 * components write the same nodes, so serialization and hydration read either.
 */

const piParsingByDocument = new WeakMap<Document, boolean>();
export function documentParsesInstructions(document: Document): boolean {
  let piParsing = piParsingByDocument.get(document);
  if (piParsing === undefined) {
    const probe = document.createElement("div");
    probe.innerHTML = '<?probe x="1"?>';
    piParsing = probe.firstChild?.nodeType === 7;
    piParsingByDocument.set(document, piParsing);
  }
  return piParsing;
}
/**
 * A rendered-form mark: a processing instruction, or, where the parser does not produce them, the
 * comment it would produce instead, so a lowered DOM and a hydrated DOM hold the same nodes.
 */
export function renderedFormMark(document: Document, target: string, data: string): Node {
  return documentParsesInstructions(document)
    ? document.createProcessingInstruction(target, data)
    : document.createComment(`?${target}${data === "" ? "" : ` ${data}`}?`);
}

