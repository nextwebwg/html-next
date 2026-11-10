import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PreparationRequest, PreparationService } from "./looma-preparation.js";

const { prepareModule }: typeof import("./looma-preparation.js") = await import(new URL("./looma-preparation.ts", import.meta.url).href);

/** Feed the unchanged browser scenarios native initial HTML before their normal adapter adopts it. */
export function browserPlugins(files: { scene: string; applications: string }) {
  const id = "\0looma-dotnet-browser-scene";
  let rendered = 0;
  return [{
    name: "looma-dotnet-browser-scenes",
    enforce: "pre" as const,
    resolveId(name: string, _importer: unknown, options: { ssr?: boolean }) {
      if (name === "@looma-test/scene" && !options?.ssr) return id;
    },
    load(name: string) {
      if (name !== id) return;
      const origin = JSON.parse(process.env.LOOMA_FIXTURE_SERVERS ?? "{}").production as string | undefined;
      if (!origin) throw new Error("Start the fixture servers before loading native browser scenes.");
      return `export * from ${JSON.stringify(files.scene)};
import { createHydratedScene, settle as settleBrowser } from ${JSON.stringify(files.scene)};
import { sceneApplications } from ${JSON.stringify(files.applications)};
const tasks = new Set();
const endpoint = ${JSON.stringify(origin + "/__looma-native-render")};
globalThis.__loomaNativeRenderTasks = () => [...tasks];
export async function settle() { await Promise.all([...tasks]); await settleBrowser(); }
export function createScene(options) {
  const scene = createHydratedScene(options);
  let active;
  return { ...scene,
    mount(target) {
      if (active) throw new Error("A scene is already mounted.");
      const element = typeof target === "string" ? document.querySelector(target) : target;
      if (!element) throw new Error("Missing native scene mount target.");
      const abort = active = new AbortController();
      const task = (async () => {
        try {
          const html = [];
          for (const request of sceneApplications(scene)) {
            if ("html" in request) { html.push(request.html); continue; }
            const response = await fetch(endpoint, {
              method: "POST", body: JSON.stringify({ ...request, locale: new Intl.NumberFormat().resolvedOptions().locale }), signal: abort.signal
            });
            if (!response.ok) throw new Error(response.status + " " + response.url + ": " + await response.text());
            html.push(await response.text());
          }
          if (abort.signal.aborted) return;
          element.innerHTML = html.join("");
          scene.mount(element);
        } catch (error) { if (!abort.signal.aborted) throw error; }
      })();
      tasks.add(task);
      task.then(() => tasks.delete(task), () => {});
    },
    unmount() { active?.abort(); active = undefined; scene.unmount(); }
  };
}`;
    },
    configureServer(server: { middlewares: { use(callback: (request: IncomingMessage, response: ServerResponse, next: () => void) => void): void } }) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/__looma-native-render") { next(); return; }
        response.setHeader("Access-Control-Allow-Origin", "*");
        void (async () => {
          try {
            let body = "";
            for await (const part of request) body += part;
            const html = await renderApplication(JSON.parse(body));
            rendered++;
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(html);
          } catch (error) { response.statusCode = 500; response.end(String(error)); }
        })();
      });
    },
    closeBundle() {
      if (rendered) console.log(`Rendered ${rendered} initial browser scenes through C# at the fixture endpoint.`);
      rendered = 0;
    },
  }];
}

export function renderApplication(request: { source: string; inputs: object; locale?: string }): Promise<string> {
  const endpoint = JSON.parse(process.env.LOOMA_DOTNET_ENDPOINT ?? "null") as { host: string; port: number } | null;
  if (!endpoint) throw new Error("Start the native catalog fixture host before rendering a Looma scene.");
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const lines = createInterface({ input: socket });
    const abort = new AbortController();
    let pending: { resolve(value: PreparationRequest["values"]): void; reject(error: Error): void } | undefined;
    let answered = false;
    socket.once("error", reject);
    socket.once("connect", () => { socket.write(JSON.stringify({ ...request, locale: request.locale ?? new Intl.NumberFormat().resolvedOptions().locale }) + "\n"); });
    lines.on("line", line => {
      try {
        const response = JSON.parse(line);
        if (response.kind === "inputs") { pending!.resolve(response.values); pending = undefined; return; }
        if (response.kind === "prepare") {
          const file = process.env.LOOMA_DOTNET_PREPARATION_SERVICE;
          if (!file) throw new Error("Missing native module preparation service.");
          void import(pathToFileURL(file).href).then(service => prepareModule(service as PreparationService, response, names =>
            new Promise((resolve, reject) => { pending = { resolve, reject }; socket.write(JSON.stringify({ kind: "read", names }) + "\n"); }), abort.signal))
            .then(result => { if (!socket.destroyed) socket.write(JSON.stringify({ kind: "prepared", ...result }) + "\n"); })
            .catch(error => { if (!socket.destroyed) socket.write(JSON.stringify({ kind: "error", error: String(error) }) + "\n"); });
          return;
        }
        answered = true;
        if (response.error) reject(new Error(response.error));
        else if (response.renderer !== "dotnet") reject(new Error("The catalog response did not come from the native renderer."));
        else resolve(response.html);
        lines.close(); socket.destroy();
      } catch (error) { reject(error); lines.close(); socket.destroy(); }
    });
    socket.once("close", () => {
      const error = new Error("The native catalog fixture host closed before rendering.");
      abort.abort(error); pending?.reject(error);
      if (!answered) reject(error);
    });
  });
}
