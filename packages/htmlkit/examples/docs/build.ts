import { fileURLToPath } from "node:url";
import { buildDocsProof } from "./proof.js";

const root = fileURLToPath(new URL("../../../../.context/htmlkit-docs-proof/", import.meta.url));
const guides = fileURLToPath(new URL("../../../../docs/guide/", import.meta.url));
const result = await buildDocsProof(root, guides);
console.log(`Documentation proof: ${result.routes.length} pages in ${result.outDir}`);
