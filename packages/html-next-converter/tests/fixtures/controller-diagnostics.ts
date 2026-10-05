export const controllerDiagnosticCases = [
  { tag: "x-load-failure", code: "HJ001", source: `<template component="x-load-failure" status="early" summary="Load failure." controller="./bad.js"><button type="button">Ready</button></template>`,
    controller: `throw new Error("load exploded"); export default function controller() {}`,
    message: "Controller module `https://app.example/components/bad.js` failed to load: load exploded." },
  { tag: "x-invalid-export", code: "HJ002", source: `<template component="x-invalid-export" status="early" summary="Invalid export." controller="./bad.js"><button type="button">Ready</button></template>`,
    controller: "export default 7;",
    message: "Controller module `https://app.example/components/bad.js` must default-export a function." },
] as const;
