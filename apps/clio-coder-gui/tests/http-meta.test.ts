import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Value } from "typebox/value";
import { Problem } from "../contracts/common.js";
import { Meta } from "../contracts/meta.js";
import { routes } from "../contracts/routes.js";
import { harness } from "./harness/app.js";

test("meta authentication, Host, Origin, version, snapshots, and exhaustive route registration", async (t) => {
	const h = await harness();
	t.after(h.close);
	const unauthorized = await h.app.request("http://127.0.0.1:4317/api/meta");
	assert.equal(unauthorized.status, 401);
	assert.match(unauthorized.headers.get("content-type") ?? "", /application\/problem\+json/);
	assert.ok(Value.Check(Problem, await unauthorized.json()));
	assert.equal((await h.request("/api/meta", { headers: { Host: "example.com" } })).status, 421);
	assert.equal((await h.request("/api/meta", { headers: { Origin: "https://example.com" } })).status, 401);
	assert.equal((await h.request("/api/meta?token=test-token", { headers: { Authorization: "" } })).status, 401);
	const response = await h.request("/api/meta");
	const meta = await response.json();
	assert.ok(Value.Check(Meta, meta));
	const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
	assert.equal(meta.clio, pkg.version);
	assert.equal(response.headers.get("X-Clio-Epoch"), meta.epoch);
	assert.equal(response.headers.get("X-Clio-Seq"), "0");
	const registered = h.app.routes.filter((route) =>
		Object.values(routes).some((entry) => entry.path === route.path && entry.method === route.method),
	);
	assert.deepEqual(
		registered.map((route) => `${route.method} ${route.path}`).sort(),
		Object.values(routes)
			.map((route) => `${route.method} ${route.path}`)
			.sort(),
	);
	assert.equal((await h.request("/api/missing")).status, 404);
	assert.equal((await h.request("/api/meta?unexpected=1")).status, 422);
});
