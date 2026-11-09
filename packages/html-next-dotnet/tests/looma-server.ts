import { createConnection } from "node:net";
import { createInterface } from "node:readline";

export function renderApplication(request: { source: string; inputs: object }): Promise<string> {
  const endpoint = JSON.parse(process.env.LOOMA_DOTNET_ENDPOINT ?? "null") as { host: string; port: number } | null;
  if (!endpoint) throw new Error("Start the native catalog fixture host before rendering a Looma scene.");
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const lines = createInterface({ input: socket });
    let answered = false;
    socket.once("error", reject);
    socket.once("connect", () => { socket.write(JSON.stringify({ ...request, locale: new Intl.NumberFormat().resolvedOptions().locale }) + "\n"); });
    lines.once("line", line => {
      answered = true;
      try {
        const response = JSON.parse(line) as { renderer: string; error?: string; html: string };
        if (response.error) reject(new Error(response.error));
        else if (response.renderer !== "dotnet") reject(new Error("The catalog response did not come from the native renderer."));
        else resolve(response.html);
      } catch (error) { reject(error); }
      finally { lines.close(); socket.destroy(); }
    });
    socket.once("close", () => { if (!answered) reject(new Error("The native catalog fixture host closed before rendering.")); });
  });
}
