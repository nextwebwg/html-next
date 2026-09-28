/** Native setHTML() results independently observed in Chromium and Firefox. */
export const cases = [
  {
    input: `<p class=x id=y title=t>Hi <b>there</b><!--comment--></p><img src=/x alt=x>`,
    expected: `<p title="t">Hi <b>there</b></p>`,
  },
  {
    input: `<x-box><b>inner</b></x-box><script>window.unsafeFlag=1</script><a href=javascript:alert(1) target=_blank>bad</a>`,
    expected: `<a>bad</a>`,
  },
  {
    input: `<svg viewBox="0 0 10 10"><circle cx=5 cy=5 r=4 fill=red onclick=alert(1)></circle><script>alert(1)</script></svg>`,
    expected: `<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"></circle></svg>`,
  },
  {
    input: `<math><mi mathcolor=red>x</mi><mfrac><mn>1</mn><mn>2</mn></mfrac></math>`,
    expected: `<math><mi mathcolor="red">x</mi><mfrac><mn>1</mn><mn>2</mn></mfrac></math>`,
  },
  {
    input: `<table><tbody><tr><td>A</td></tr></tbody></table><p>End`,
    expected: `<table><tbody><tr><td>A</td></tr></tbody></table><p>End</p>`,
  },
  {
    input: `<a href=data:text/html,hi title=x>data</a><a href=java&#x0A;script:alert(1)>js</a>`,
    expected: `<a href="data:text/html,hi" title="x">data</a><a>js</a>`,
  },
  {
    input: `<svg><foreignObject><p title=x>hello</p><img src=x></foreignObject></svg>`,
    expected: `<svg><foreignObject><p title="x">hello</p></foreignObject></svg>`,
  },
] as const;

/** Parser-mutation inputs adapted from DOMPurify's public regression fixtures. */
export const mutationInputs = [
  `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">`,
  `<math><mtext><table><mglyph><style><math href=javascript:alert(1)>CLICKME</math>`,
  `<svg></p><math><title><style><img src=x onerror=alert(1)></style></title>`,
  `<svg><p><style><g title="</style><img src=x onerror=alert(1)">`,
  `<math><mtext><option><FAKEFAKE><option></option><mglyph><svg><mtext><style><a title="</style><img src='#' onerror='alert(1)'>">`,
] as const;
