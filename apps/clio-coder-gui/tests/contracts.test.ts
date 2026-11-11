import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { Type } from "typebox";
import { createClient } from "../client/api/client.js";
import { Empty, Id } from "../contracts/common.js";
import { defineRoute, routes } from "../contracts/routes.js";
import { SessionDeltaKinds } from "../contracts/runtime.js";
import { routes as runtimeRoutes } from "../contracts/runtime-routes.js";
import { SessionDeltas } from "../contracts/sessions.js";
import { register } from "../server/http/validate.js";
import { EventHub } from "../server/services/event-hub.js";
import { credentialFetch } from "./harness/browser-fetch.js";

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
	const client = createClient(
		{ ticket: "ticket" },
		credentialFetch(async (url, options) => {
			assert.equal(url, "/api/toolchain/tools/herdr/install");
			assert.equal(options?.method, "POST");
			assert.equal(options.body, '{"force":true}');
			return new Response('{"operationId":"test-op"}', { status: 202 });
		}),
	);
	assert.deepEqual(
		await client.call(runtimeRoutes.install, { params: { toolId: "herdr" }, query: {}, body: { force: true } }),
		{ operationId: "test-op" },
	);
	client.credentials.dispose();
	function compileTimeChecks() {
		// @ts-expect-error The route's body does not accept a string force flag.
		void client.call(runtimeRoutes.install, { params: { toolId: "herdr" }, query: {}, body: { force: "yes" } });
		// @ts-expect-error Handler output must satisfy the route response.
		register(app, new EventHub(), routes.tools, () => ({ wrong: true }));
		// @ts-expect-error Path parameter names come from the route table.
		void client.call(runtimeRoutes.operation, { params: { toolId: "herdr" }, query: {}, body: {} });
	}
	void compileTimeChecks;
});

test("browser handles and subscription kinds preserve the server's complete contract", () => {
	assert.deepEqual(Object.keys(runtimeRoutes).sort(), Object.keys(routes).sort());
	for (const handle of Object.values(runtimeRoutes)) {
		assert.equal(handle.method, routes[handle.name].method, handle.name);
		assert.equal(handle.path, routes[handle.name].path, handle.name);
	}
	assert.deepEqual(Object.keys(SessionDeltaKinds).sort(), Object.keys(SessionDeltas).sort());
});
