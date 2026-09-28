// Pinned snapshot of the HTML Sanitizer safe default observed in Chromium and Firefox.
// Browser conformance tests compare this policy with native Sanitizer.get(), and use
// setHTML() only as a differential oracle, never as the rendering path.
export const SAFE_GLOBAL_ATTRIBUTES = new Set(["alignment-baseline","baseline-shift","clip-path","clip-rule","color","color-interpolation","cursor","dir","direction","display","displaystyle","dominant-baseline","fill","fill-opacity","fill-rule","font-family","font-size","font-size-adjust","font-stretch","font-style","font-variant","font-weight","lang","letter-spacing","marker-end","marker-mid","marker-start","mathbackground","mathcolor","mathsize","opacity","paint-order","pointer-events","scriptlevel","shape-rendering","stop-color","stop-opacity","stroke","stroke-dasharray","stroke-dashoffset","stroke-linecap","stroke-linejoin","stroke-miterlimit","stroke-opacity","stroke-width","text-anchor","text-decoration","text-overflow","text-rendering","title","transform","transform-origin","unicode-bidi","vector-effect","visibility","white-space","word-spacing","writing-mode"]);
export const SAFE_DEFAULT_ELEMENTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "html": {
    "a": [
      "href",
      "hreflang",
      "type"
    ],
    "abbr": [],
    "address": [],
    "article": [],
    "aside": [],
    "b": [],
    "bdi": [],
    "bdo": [],
    "blockquote": [
      "cite"
    ],
    "body": [],
    "br": [],
    "caption": [],
    "cite": [],
    "code": [],
    "col": [
      "span"
    ],
    "colgroup": [
      "span"
    ],
    "data": [
      "value"
    ],
    "dd": [],
    "del": [
      "cite",
      "datetime"
    ],
    "dfn": [],
    "div": [],
    "dl": [],
    "dt": [],
    "em": [],
    "figcaption": [],
    "figure": [],
    "footer": [],
    "h1": [],
    "h2": [],
    "h3": [],
    "h4": [],
    "h5": [],
    "h6": [],
    "head": [],
    "header": [],
    "hgroup": [],
    "hr": [],
    "html": [],
    "i": [],
    "ins": [
      "cite",
      "datetime"
    ],
    "kbd": [],
    "li": [
      "value"
    ],
    "main": [],
    "mark": [],
    "menu": [],
    "nav": [],
    "ol": [
      "reversed",
      "start",
      "type"
    ],
    "p": [],
    "pre": [],
    "q": [],
    "rp": [],
    "rt": [],
    "ruby": [],
    "s": [],
    "samp": [],
    "search": [],
    "section": [],
    "small": [],
    "span": [],
    "strong": [],
    "sub": [],
    "sup": [],
    "table": [],
    "tbody": [],
    "td": [
      "colspan",
      "headers",
      "rowspan"
    ],
    "tfoot": [],
    "th": [
      "abbr",
      "colspan",
      "headers",
      "rowspan",
      "scope"
    ],
    "thead": [],
    "time": [
      "datetime"
    ],
    "title": [],
    "tr": [],
    "u": [],
    "ul": [],
    "var": [],
    "wbr": []
  },
  "svg": {
    "a": [
      "href",
      "hreflang",
      "type"
    ],
    "circle": [
      "cx",
      "cy",
      "pathLength",
      "r"
    ],
    "defs": [],
    "desc": [],
    "ellipse": [
      "cx",
      "cy",
      "pathLength",
      "rx",
      "ry"
    ],
    "foreignObject": [
      "height",
      "width",
      "x",
      "y"
    ],
    "g": [],
    "line": [
      "pathLength",
      "x1",
      "x2",
      "y1",
      "y2"
    ],
    "marker": [
      "markerHeight",
      "markerUnits",
      "markerWidth",
      "orient",
      "preserveAspectRatio",
      "refX",
      "refY",
      "viewBox"
    ],
    "metadata": [],
    "path": [
      "d",
      "pathLength"
    ],
    "polygon": [
      "pathLength",
      "points"
    ],
    "polyline": [
      "pathLength",
      "points"
    ],
    "rect": [
      "height",
      "pathLength",
      "rx",
      "ry",
      "width",
      "x",
      "y"
    ],
    "svg": [
      "height",
      "preserveAspectRatio",
      "viewBox",
      "width",
      "x",
      "y"
    ],
    "text": [
      "dx",
      "dy",
      "lengthAdjust",
      "rotate",
      "textLength",
      "x",
      "y"
    ],
    "textPath": [
      "lengthAdjust",
      "method",
      "path",
      "side",
      "spacing",
      "startOffset",
      "textLength"
    ],
    "title": [],
    "tspan": [
      "dx",
      "dy",
      "lengthAdjust",
      "rotate",
      "textLength",
      "x",
      "y"
    ]
  },
  "mathml": {
    "math": [],
    "merror": [],
    "mfrac": [],
    "mi": [],
    "mmultiscripts": [],
    "mn": [],
    "mo": [
      "fence",
      "form",
      "largeop",
      "lspace",
      "maxsize",
      "minsize",
      "movablelimits",
      "rspace",
      "separator",
      "stretchy",
      "symmetric"
    ],
    "mover": [
      "accent"
    ],
    "mpadded": [
      "depth",
      "height",
      "lspace",
      "voffset",
      "width"
    ],
    "mphantom": [],
    "mprescripts": [],
    "mroot": [],
    "mrow": [],
    "ms": [],
    "mspace": [
      "depth",
      "height",
      "width"
    ],
    "msqrt": [],
    "mstyle": [],
    "msub": [],
    "msubsup": [],
    "msup": [],
    "mtable": [],
    "mtd": [
      "columnspan",
      "rowspan"
    ],
    "mtext": [],
    "mtr": [],
    "munder": [
      "accentunder"
    ],
    "munderover": [
      "accent",
      "accentunder"
    ],
    "semantics": []
  }
};
