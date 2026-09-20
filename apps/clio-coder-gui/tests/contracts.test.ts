import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { Type } from "typebox";
import { createClient } from "../client/api/client.js";
import { Empty, Id } from "../contracts/common.js";
import { defineRoute, routes } from "../contracts/routes.js";
import { register } from "../server/http/validate.js";
import { EventHub } from "../server/services/event-hub.js";

test("table adapter parses path, numeric and boolean queries; typed client uses its verb/path/body", async () => {
	const route = defineRoute({
		method: "GET",
		path: "/probe/:id",
		params: Type.Object({ id: Id }),
		query: Type.Object({ limit: Type.Integer({ minimum: 1, maximum: 200 }), enabled: Type.Boolean() }),
		body: Empty,
		response: Type.Object({ id: Id, limit: Type.Integer(), enabled: Type.Boolean() }),
		status: 200,
		summary: "Typed parameter probe",
	});
	const app = new Hono();
	register(app, new EventHub(), route, ({ params, query }) => ({ ...params, ...query }));
	assert.deepEqual(await (await app.request("/probe/tool-1?limit=200&enabled=true")).json(), {
		id: "tool-1",
		limit: 200,
		enabled: true,
	});
	const client = createClient("token", async (url, options) => {
		assert.equal(url, "/api/toolchain/tools/herdr/install");
		assert.equal(options?.method, "POST");
		assert.equal(options.body, '{"force":true}');
		return new Response('{"operationId":"test-op"}', { status: 202 });
	});
	assert.deepEqual(
		await client.call(routes.install, { params: { toolId: "herdr" }, query: {}, body: { force: true } }),
		{ operationId: "test-op" },
	);
	function compileTimeChecks() {
		// @ts-expect-error The route's body does not accept a string force flag.
		void client.call(routes.install, { params: { toolId: "herdr" }, query: {}, body: { force: "yes" } });
		// @ts-expect-error Handler output must satisfy the route response.
		register(app, new EventHub(), routes.tools, () => ({ wrong: true }));
		// @ts-expect-error Path parameter names come from the route table.
		void client.call(routes.operation, { params: { toolId: "herdr" }, query: {}, body: {} });
	}
	void compileTimeChecks;
});
