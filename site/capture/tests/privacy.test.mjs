import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { plain, scanChunks } from "../privacy.mjs";

const fixture = JSON.parse(readFileSync(new URL("privacy-stream.json", import.meta.url), "utf8"));
const scan = (chunks) => [...scanChunks(chunks), ...scanChunks(chunks.map(plain))];

test("a strict prefix of the sandbox home that ends a chunk is allowed", () => {
	for (const chunks of fixture.allowed) assert.deepEqual(scan(chunks), [], JSON.stringify(chunks));
});

test("every other home path is refused", () => {
	for (const { why, chunks } of fixture.refused)
		assert.ok(
			scan(chunks).some((hit) => hit.startsWith("a home path")),
			why,
		);
});
