import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "../client/api/client.js";
import { HomeLaunch } from "../client/pages/home-launch.js";

function fixture() {
	const requests: { path: string; body: unknown; key: string | null }[] = [];
	let turnFailure: "network" | "refused" | null = null;
	const client = createClient("fixture", async (url, options) => {
		const path = String(url);
		requests.push({
			path,
			body: JSON.parse(String(options?.body ?? "{}")),
			key: new Headers(options?.headers).get("Idempotency-Key"),
		});
		if (path.endsWith("/turns") && turnFailure) {
			const failure = turnFailure;
			turnFailure = null;
			if (failure === "network") throw new TypeError("lost response");
			return Response.json(
				{ title: "Refused", status: 409, detail: "Choose a configured model", code: "conflict" },
				{ status: 409 },
			);
		}
		return Response.json(
			path === "/api/workspaces"
				? { id: "w1", path: "/project", name: "Project" }
				: { id: "s1", workspaceId: "w1", state: "open" },
		);
	});
	return {
		requests,
		launch: new HomeLaunch(client),
		failTurn: (kind: "network" | "refused") => {
			turnFailure = kind;
		},
	};
}

test("home launches only on explicit action, opens a folder then sends once, and coalesces double presses", async () => {
	const f = fixture();
	assert.equal(f.requests.length, 0);
	const first = f.launch.start({ id: null, path: "/project" }, "  Explain this project  ");
	assert.equal(first, f.launch.start({ id: null, path: "/project" }, "Explain this project"));
	assert.equal((await first).id, "s1");
	assert.deepEqual(
		f.requests.map((r) => r.path),
		["/api/workspaces", "/api/workspaces/w1/sessions", "/api/sessions/s1/turns"],
	);
	assert.deepEqual(f.requests.at(-1)?.body, { text: "Explain this project" });
	assert.ok(f.requests.every((r) => r.key));
});

test("empty conversation skips turn submission and existing projects skip opening", async () => {
	const f = fixture();
	await f.launch.start({ id: "w1", path: "/project" }, "");
	assert.deepEqual(
		f.requests.map((r) => r.path),
		["/api/workspaces/w1/sessions"],
	);
});

test("uncertain turn retry reuses its session and idempotency key without losing the task", async () => {
	const f = fixture();
	f.failTurn("network");
	await assert.rejects(f.launch.start({ id: "w1", path: "/project" }, "Task"), /Cannot reach/);
	assert.equal(f.launch.session?.id, "s1");
	await f.launch.start({ id: "w1", path: "/project" }, "Task");
	assert.equal(f.requests.filter((r) => r.path.endsWith("/sessions")).length, 1);
	const turns = f.requests.filter((r) => r.path.endsWith("/turns"));
	assert.equal(turns.length, 2);
	assert.equal(turns[0]?.key, turns[1]?.key);
	assert.deepEqual(turns[1]?.body, { text: "Task" });
});

test("definite model refusal keeps the created conversation and permits a fresh reviewed retry", async () => {
	const f = fixture();
	f.failTurn("refused");
	await assert.rejects(f.launch.start({ id: "w1", path: "/project" }, "Task"), /Choose a configured model/);
	await f.launch.start({ id: "w1", path: "/project" }, "Task");
	const turns = f.requests.filter((r) => r.path.endsWith("/turns"));
	assert.notEqual(turns[0]?.key, turns[1]?.key);
	assert.equal(f.requests.filter((r) => r.path.endsWith("/sessions")).length, 1);
});

test("missing project and oversized task fail before mutation", async () => {
	const f = fixture();
	await assert.rejects(f.launch.start({ id: null, path: " " }, "Task"), /Choose a project/);
	await assert.rejects(f.launch.start({ id: "w1", path: "/project" }, "x".repeat(32001)), /32,000/);
	assert.equal(f.requests.length, 0);
});
