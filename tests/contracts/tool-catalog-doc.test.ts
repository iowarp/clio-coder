import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";

const DOC = readFileSync(new URL("../../docs/architecture/prompt-envelope-and-tools.md", import.meta.url), "utf8");

it("states the builtin tool count ToolNames actually has", () => {
	const stated = DOC.match(/The canonical builtin catalog contains (\d+) tools/u)?.[1];
	ok(stated, "the count sentence moved; update this test with it");
	strictEqual(Number(stated), Object.values(ToolNames).length);
});

it("places every builtin tool in the plane table exactly once", () => {
	const table = DOC.slice(DOC.indexOf("| Plane | Tools |"), DOC.indexOf("Several tools sit in a plane"));
	const listed = [...table.matchAll(/^\| [A-Z]+ \| (.+?) \|/gmu)].flatMap((row) =>
		[...(row[1] ?? "").matchAll(/`([a-z_]+)`/gu)].map((name) => name[1]),
	);
	deepStrictEqual([...listed].sort(), [...Object.values(ToolNames)].sort());
});
