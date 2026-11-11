import assert from "node:assert/strict";
import { test } from "node:test";
import {
	markTokenRejected,
	onTokenRejected,
	originFromLaunchInput,
	ticketFromLaunchInput,
	tokenRejected,
} from "../client/api/auth-state.js";
import { createClient } from "../client/api/client.js";
import { routes } from "../contracts/routes.js";

const ticket = "vuKW1cCI27gT7rji4ZVCVRhxVCrjwFgDJm6A8uEIhwY";
const problem = (status: number) =>
	new Response(
		JSON.stringify({
			type: "urn:clio-coder:problem:unauthorized",
			title: "unauthorized",
			status,
			detail: "A launch ticket, a launch proof or a live credential is required.",
			code: "unauthorized",
			instance: "i",
		}),
		{ status, headers: { "content-type": "application/problem+json" } },
	);

test("a pasted launch link, or one with a path, yields its ticket; a token link or anything else yields nothing", () => {
	assert.equal(ticketFromLaunchInput(`http://127.0.0.1:4317/#ticket=${ticket}`), ticket);
	assert.equal(ticketFromLaunchInput(`  [clio-coder:gui] http://127.0.0.1:4317/library#ticket=${ticket}\n`), ticket);
	assert.equal(ticketFromLaunchInput(`http://127.0.0.1:4317/#token=${ticket}`), null);
	assert.equal(ticketFromLaunchInput(ticket), null);
	assert.equal(ticketFromLaunchInput("http://127.0.0.1:4317/"), null);
	assert.equal(ticketFromLaunchInput("#ticket=short"), null);
	assert.equal(ticketFromLaunchInput(""), null);
});

test("only a 401 marks the token refused: a wrong-host 421 and a 503 leave the browser connected", async () => {
	assert.equal(tokenRejected(), false);
	// The event stream learns of a refusal that an ordinary request found after the stream's last error.
	let told = 0;
	let cancelled = 0;
	onTokenRejected(() => told++);
	onTokenRejected(() => cancelled++)();
	for (const status of [421, 503]) {
		const client = createClient({ ticket }, async () => problem(status));
		await assert.rejects(client.call(routes.meta, { params: {}, query: {}, body: {} }));
		assert.equal(tokenRejected(), false, String(status));
	}
	const client = createClient({ ticket }, async () => problem(401));
	await assert.rejects(client.call(routes.meta, { params: {}, query: {}, body: {} }), /fresh launch link/);
	assert.equal(tokenRejected(), true);
	markTokenRejected();
	assert.equal(tokenRejected(), true);
	assert.deepEqual([told, cancelled], [1, 0]);
	// A subscriber that arrives after the refusal is told at once.
	onTokenRejected(() => told++);
	assert.equal(told, 2);
});

test("recovery retains the new local origin and refuses remote launch links", () => {
	assert.equal(
		originFromLaunchInput(`[clio-coder:gui] http://127.0.0.1:4343/#ticket=${ticket}`),
		"http://127.0.0.1:4343",
	);
	assert.equal(originFromLaunchInput(`http://127.0.0.1:7373/#ticket=${ticket}`), "http://127.0.0.1:7373");
	assert.equal(ticketFromLaunchInput(`http://example.com/#ticket=${ticket}`), null);
	assert.equal(ticketFromLaunchInput(`http://127.0.0.1@evil.example/#ticket=${ticket}`), null);
});
