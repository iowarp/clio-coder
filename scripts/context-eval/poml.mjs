/** Exercise POML's actual renderer separately from lossless XML wrapper extraction. */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const [prefix, formats] = process.argv.slice(2);
const req = createRequire(join(prefix, "package.json"));
const { read, write } = await import(req.resolve("pomljs"));
const body = readFileSync(join(formats, "poml.txt"), "utf8");
const start = performance.now();
let result;
try {
	const rendered = write(await read(body));
	const raw = readFileSync(join(formats, "json.txt"), "utf8");
	result = {
		version: "0.0.8",
		renderMs: performance.now() - start,
		renderedType: typeof rendered,
		renderedBytes: Buffer.byteLength(JSON.stringify(rendered)),
		matchesJson: typeof rendered === "string" && rendered.trim() === raw.trim(),
		rendered,
	};
} catch (error) {
	result = { version: "0.0.8", renderMs: performance.now() - start, error: String(error) };
}
writeFileSync(join(formats, "poml-renderer.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, rendered: undefined }));
