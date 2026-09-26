/** Equivalent information, reversible formats; dependencies live in an external benchmark prefix. */
import { deepStrictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const [input, prefix, implementation, out] = process.argv.slice(2);
const req = createRequire(join(prefix, "package.json"));
const { encode, decode } = await import(req.resolve("@toon-format/toon"));
const toml = createRequire(join(implementation, "package.json"))("smol-toml");
const value = JSON.parse(readFileSync(input, "utf8"));
mkdirSync(out, { recursive: true });
const rows = [];
for (const [name, serialize, parse] of [
	["json", JSON.stringify, JSON.parse],
	["pretty-json", (v) => JSON.stringify(v, null, 2), JSON.parse],
	["toml", toml.stringify, toml.parse],
	["toon", encode, decode],
]) {
	const t = performance.now();
	const body = serialize(value);
	const generatedMs = performance.now() - t;
	const times = [];
	for (let i = 0; i < 5; i++) {
		const p = performance.now();
		const parsed = parse(body);
		times.push(performance.now() - p);
		deepStrictEqual(parsed, value);
	}
	writeFileSync(join(out, `${name}.txt`), body);
	rows.push({ name, bytes: Buffer.byteLength(body), generatedMs, parseMs: times, roundTrip: true });
}
writeFileSync(
	join(out, "node-results.json"),
	`${JSON.stringify(
		{
			node: process.version,
			inputSha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
			versions: {
				toon: JSON.parse(readFileSync(join(prefix, "node_modules/@toon-format/toon/package.json"), "utf8")).version,
				toml: toml === null ? null : "1.8.0",
			},
			rows,
		},
		null,
		2,
	)}\n`,
);
