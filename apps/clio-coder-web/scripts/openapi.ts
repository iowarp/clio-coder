import { writeFile } from "node:fs/promises";
import { openapiText } from "../contracts/openapi.js";

await writeFile(new URL("../contracts/openapi.json", import.meta.url), openapiText());
