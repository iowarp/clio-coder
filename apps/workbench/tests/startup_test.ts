import { equal, rejects } from "node:assert/strict";
import { fetchWithNetworkRetry, stylesheetFailed } from "../src/startup.ts";

Deno.test("a bootstrap fetch that the browser cancelled is retried until it answers", async () => {
	let calls = 0;
	const response = await fetchWithNetworkRetry(
		() => {
			calls += 1;
			return calls < 3 ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(new Response("ok"));
		},
		new AbortController().signal,
		[1, 1, 1],
	);
	equal(await response.text(), "ok");
	equal(calls, 3);
});

Deno.test("the retry gives up after the last delay and surfaces the network error", async () => {
	let calls = 0;
	await rejects(
		fetchWithNetworkRetry(
			() => {
				calls += 1;
				return Promise.reject(new TypeError("Failed to fetch"));
			},
			new AbortController().signal,
			[1, 1],
		),
		TypeError,
	);
	equal(calls, 3);
});

Deno.test("only network failures are retried: HTTP and protocol errors return at once", async () => {
	let calls = 0;
	await rejects(
		fetchWithNetworkRetry(
			() => {
				calls += 1;
				return Promise.reject(new Error("Bootstrap failed with HTTP 500."));
			},
			new AbortController().signal,
			[1, 1],
		),
		/HTTP 500/u,
	);
	equal(calls, 1);
	const okResponse = await fetchWithNetworkRetry(
		() => Promise.resolve(new Response(null, { status: 404 })),
		new AbortController().signal,
	);
	equal(okResponse.status, 404);
});

Deno.test("an unmounted renderer stops retrying", async () => {
	const controller = new AbortController();
	let calls = 0;
	await rejects(
		fetchWithNetworkRetry(
			() => {
				calls += 1;
				controller.abort();
				return Promise.reject(new TypeError("Failed to fetch"));
			},
			controller.signal,
			[1, 1],
		),
		TypeError,
	);
	equal(calls, 1);
});

Deno.test("a stylesheet link counts as failed when its sheet is missing, empty, or unreadable", () => {
	const link = (sheet: unknown) => ({ sheet }) as unknown as HTMLLinkElement;
	equal(stylesheetFailed(link(null)), true);
	equal(stylesheetFailed(link({ cssRules: { length: 0 } })), true);
	equal(
		stylesheetFailed(link({
			get cssRules(): never {
				throw new DOMException("Cannot access rules", "SecurityError");
			},
		})),
		true,
	);
	equal(stylesheetFailed(link({ cssRules: { length: 983 } })), false);
});
