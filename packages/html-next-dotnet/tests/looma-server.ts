import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { PreparationRequest, PreparationService } from "./looma-preparation.js";

const { prepareModule }: typeof import("./looma-preparation.js") = await import(new URL("./looma-preparation.ts", import.meta.url).href);

export function renderApplication(request: { source: string; inputs: object }): Promise<string> {
  const endpoint = JSON.parse(process.env.LOOMA_DOTNET_ENDPOINT ?? "null") as { host: string; port: number } | null;
  if (!endpoint) throw new Error("Start the native catalog fixture host before rendering a Looma scene.");
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const lines = createInterface({ input: socket });
    const abort = new AbortController();
    let pending: { resolve(value: PreparationRequest["values"]): void; reject(error: Error): void } | undefined;
    let answered = false;
    socket.once("error", reject);
    socket.once("connect", () => { socket.write(JSON.stringify({ ...request, locale: new Intl.NumberFormat().resolvedOptions().locale }) + "\n"); });
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
