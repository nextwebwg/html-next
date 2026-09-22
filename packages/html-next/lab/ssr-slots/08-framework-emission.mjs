// Q2: what each framework's SSR can emit for a slot region, and how it keeps adjacent text apart.
import { createElement as h, Fragment } from "react";
import { renderToString } from "react-dom/server";
import { createSSRApp, h as vh, createCommentVNode } from "vue";
import { renderToString as vueToString } from "vue/server-renderer";

const out = {};
// React: template text next to children text; and the only raw-markup escape hatch.
out.reactAdjacentText = renderToString(h("p", null, "Hello ", "world"));
out.reactChildrenProp = renderToString(h(function P({ children }) { return h("p", null, "Hello ", children); }, null, "world"));
out.reactPiAsText = renderToString(h("p", null, '<?slot name="x"?>'));
out.reactRawNeedsElement = renderToString(h(Fragment, null, h("template", { dangerouslySetInnerHTML: { __html: "" } })));

// Vue: comment vnodes, and adjacent text.
out.vueComment = await vueToString(createSSRApp({ render: () => vh("p", null, [createCommentVNode('?slot name="x"?'), "world", createCommentVNode("?slot-end?")]) }));
out.vueAdjacentText = await vueToString(createSSRApp({ render: () => vh("p", null, ["Hello ", "world"]) }));
console.log(JSON.stringify(out, null, 1));
