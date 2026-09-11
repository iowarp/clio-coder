import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { openapi, openapiText } from "../contracts/openapi.js";
import { routes } from "../contracts/routes.js";

test("generated OpenAPI is current, validates as 3.1, and covers table paths and query parameters", async () => {
	const text = await readFile(new URL("../contracts/openapi.json", import.meta.url), "utf8");
	assert.deepEqual(JSON.parse(text), JSON.parse(openapiText()), "Run pnpm --filter @iowarp/clio-coder-web openapi");
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
