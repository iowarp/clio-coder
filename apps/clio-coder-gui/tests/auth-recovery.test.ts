import assert from "node:assert/strict";
import { test } from "node:test";
import { markTokenRejected, onTokenRejected, tokenFromLaunchInput, tokenRejected } from "../client/api/auth-state.js";
import { createClient } from "../client/api/client.js";
import { routes } from "../contracts/routes.js";

const token = "vuKW1cCI27gT7rji4ZVCVRhxVCrjwFgDJm6A8uEIhwY";
const problem = (status: number) =>
	new Response(
		JSON.stringify({
			type: "urn:clio-coder:problem:unauthorized",
			title: "unauthorized",
			status,
			detail: "A valid launch token is required.",
			code: "unauthorized",
			instance: "i",
		}),
		{ status, headers: { "content-type": "application/problem+json" } },
	);

test("a pasted launch link, a link with a path, or a bare token all yield the token; anything else yields nothing", () => {
	assert.equal(tokenFromLaunchInput(`http://127.0.0.1:4317/#token=${token}`), token);
	assert.equal(tokenFromLaunchInput(`  [clio-coder:gui] http://127.0.0.1:4317/library#token=${token}\n`), token);
	assert.equal(tokenFromLaunchInput(token), token);
	assert.equal(tokenFromLaunchInput("http://127.0.0.1:4317/"), null);
	assert.equal(tokenFromLaunchInput("short"), null);
	assert.equal(tokenFromLaunchInput(`#token=${"x".repeat(300)}`), null);
	assert.equal(tokenFromLaunchInput("#token=has spaces"), "has");
	assert.equal(tokenFromLaunchInput(""), null);
});

test("only a 401 marks the token refused: a wrong-host 421 and a 503 leave the browser connected", async () => {
	assert.equal(tokenRejected(), false);
	// The event stream learns of a refusal that an ordinary request found after the stream's last error.
	let told = 0;
	let cancelled = 0;
	onTokenRejected(() => told++);
	onTokenRejected(() => cancelled++)();
	for (const status of [421, 503]) {
		const client = createClient(token, async () => problem(status));
		await assert.rejects(client.call(routes.meta, { params: {}, query: {}, body: {} }));
		assert.equal(tokenRejected(), false, String(status));
	}
	const client = createClient(token, async () => problem(401));
	await assert.rejects(client.call(routes.meta, { params: {}, query: {}, body: {} }), /valid launch token/);
	assert.equal(tokenRejected(), true);
	markTokenRejected();
	assert.equal(tokenRejected(), true);
	assert.deepEqual([told, cancelled], [1, 0]);
	// A subscriber that arrives after the refusal is told at once.
	onTokenRejected(() => told++);
	assert.equal(told, 2);
});
