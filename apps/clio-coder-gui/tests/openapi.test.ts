import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { openapi, openapiText } from "../contracts/openapi.js";
import { hoistSharedSchemas } from "../contracts/openapi-hoist.js";
import { routes } from "../contracts/routes.js";

test("generated OpenAPI is current, validates as 3.1, and covers table paths and query parameters", async () => {
	const text = await readFile(new URL("../contracts/openapi.json", import.meta.url), "utf8");
	assert.deepEqual(JSON.parse(text), JSON.parse(openapiText()), "Run pnpm --filter @iowarp/clio-coder-gui openapi");
	await SwaggerParser.validate(JSON.parse(text));
	const document = openapi();
	for (const route of Object.values(routes)) {
		const path = route.path.replace(/:([A-Za-z0-9]+)/g, "{$1}");
		assert.ok(document.paths[path]?.[route.method.toLowerCase()]);
	}
	const events = document.paths["/api/events"]?.get as { parameters: { name: string; in: string }[] };
	assert.ok(events.parameters.some((param) => param.name === "after" && param.in === "query"));
	const operation = document.paths["/api/operations/{id}"]?.get as { parameters: { name: string; required: boolean }[] };
	assert.ok(operation.parameters.some((param) => param.name === "id" && param.required));
});

test("repeated shapes are hoisted once, deterministically, and every operation's problem response references Problem", async () => {
	const document = openapi();
	const schemas = document.components.schemas as Record<string, unknown>;
	const names = Object.keys(schemas);
	assert.deepEqual(names, [...names].sort(), "component names are sorted");
	// The hoisted quantity's name carries a hash of its shape, so assert the hoist, not the hash.
	assert.ok(names.includes("SessionTelemetryV1") && names.some((name) => name.startsWith("Object_display_fact_ref_")));
	// Applying the hoist to an already hoisted document changes nothing, so regeneration is byte-stable.
	assert.deepEqual(hoistSharedSchemas(document), document);
	type Operation = { responses: Record<string, { content: Record<string, { schema: unknown }> }> };
	for (const path of Object.values(document.paths))
		for (const operation of Object.values(path as Record<string, Operation>))
			assert.deepEqual(operation.responses.default?.content["application/problem+json"]?.schema, {
				$ref: "#/components/schemas/Problem",
			});
});
