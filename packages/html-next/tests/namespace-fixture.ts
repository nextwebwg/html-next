export const namespaceSource = `<template component="x-namespaces"><defs>
  <state name="destination" type="string" value="#first"></state>
  <state name="language" type="string" value="en"></state>
  <handler name="change"><set name="destination" expr:value="'#second'"></set><set name="language" expr:value="'fr'"></set></handler>
  <handler name="unsafe"><set name="destination" expr:value="'javascript:alert(1)'"></set></handler>
  </defs><article><button id="change" on:click="change">Change</button><button id="unsafe" on:click="unsafe">Unsafe</button>
  <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" from:xml:space="'preserve'">
    <use id="literal" xlink:href="#literal" xml:lang="en"></use>
    <use id="bound" from:xlink:href="$destination" from:xml:lang="$language"></use>
  </svg></article></template>`;

export const namespaceInitial = {
  literal: { href: "#literal", value: "#literal", language: "en" },
  bound: { href: "#first", value: "#first", language: "en" },
  xmlns: "http://www.w3.org/2000/svg", xlink: "http://www.w3.org/1999/xlink", space: "preserve",
};

export function namespaceSnapshot() {
  const use = (id: string) => {
    const element = document.getElementById(id) as unknown as SVGUseElement;
    return { href: element.href.baseVal, value: element.getAttributeNS("http://www.w3.org/1999/xlink", "href"), language: element.getAttributeNS("http://www.w3.org/XML/1998/namespace", "lang") };
  };
  const svg = (document.getElementById("bound") as unknown as SVGUseElement).ownerSVGElement!;
  return { literal: use("literal"), bound: use("bound"), xmlns: svg.getAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns"),
    xlink: svg.getAttributeNS("http://www.w3.org/2000/xmlns/", "xlink"), space: svg.getAttributeNS("http://www.w3.org/XML/1998/namespace", "space") };
}
