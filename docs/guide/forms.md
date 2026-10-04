---
title: HTML Forms
order: 5
blurb: request construction · fetch enhancement
eyebrow: HTML Next · Forms
---

# HTML Forms

Build requests from native forms, and submit them with `fetch` without losing native validation.

## Install

```bash
npm install @nextwebwg/html-next
```

## Independent of components

`@nextwebwg/html-next/forms` works on native `HTMLFormElement` and submitter objects and imports nothing else from the package, so a page that only wants forms pays only for this subpath. It implements the [HTML Forms proposal](/html-forms/).

## Build a request

`buildFormRequest(form, submitter?, options?)` returns the URL and `RequestInit` the form would submit, from the browser's own set of successful controls. The submitter's `formaction`, `formmethod`, and `formenctype` take precedence over the form's.

```js
import { buildFormRequest } from "@nextwebwg/html-next/forms";

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { url, init } = buildFormRequest(form, event.submitter);
  await fetch(url, init);
});
```

`GET` and `HEAD` put the fields in the query string. Other methods send a body in the form's encoding: multipart `FormData`, URL-encoded, or `text/plain`.

A `{name}` in the action URL is filled from `options.parameters`; parameters the URL does not use are appended as fields.

## Enhance a form

`enhanceForm(form, options)` submits with `fetch` and reports progress, and returns a function that removes the enhancement.

```js
import { enhanceForm } from "@nextwebwg/html-next/forms";

const stop = enhanceForm(form, {
  onState({ pending, ok, value, error }) {
    form.toggleAttribute("aria-busy", pending);
  },
});
```

The form's native validation runs first; an invalid form is never sent. A new submission aborts the previous one, and only the latest response is reported. On completion the form dispatches a `success` or `error` event with the parsed response or the error.

If the request cannot be built, the enhancement steps aside and the browser submits the form natively.
