import { ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { WORKER_RUNTIME_DESCRIPTOR_VERSION, WORKER_SPEC_VERSION } from "../../../src/worker/spec-contract.js";
import { createWorkerStdinDemux } from "../../../src/worker/stdin-demux.js";

function specJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		specVersion: WORKER_SPEC_VERSION,
		systemPrompt: "",
		task: "y",
		endpoint: { id: "local", runtime: "openai" },
		runtime: {
			version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
			id: "openai",
			kind: "http",
			apiFamily: "openai-responses",
			auth: "api-key",
		},
		runtimeId: "openai",
		wireModelId: "gpt-test",
		...overrides,
	});
}

describe("worker/stdin-demux", () => {
	it("delivers the first line as the spec and routes responses to pending approvals", async () => {
		const demux = createWorkerStdinDemux();
		const specPromise = demux.readSpec();

		demux.feed(`${specJson()}\n`);
		const spec = await specPromise;
		ok(spec.specVersion === WORKER_SPEC_VERSION && spec.task === "y", `spec=${JSON.stringify(spec)}`);

		const responsePromise = demux.awaitApproval("req-1", 1000);
		demux.feed('{"type":"clio_tool_approval_response","payload":{"requestId":"req-1","decision":"allow"}}\n');
		const response = await responsePromise;
		strictEqual(response.decision, "allow");
	});

	it("rejects awaitApproval when stdin EOFs before a response", async () => {
		const demux = createWorkerStdinDemux();
		demux.feed(`${specJson()}\n`);
		await demux.readSpec();

		const pending = demux.awaitApproval("req-1", 5000);
		demux.eof();
		try {
			await pending;
			throw new Error("expected reject");
		} catch (err) {
			ok(err instanceof Error && err.message.includes("stdin closed"));
		}
	});

	it("rejects awaitApproval on timeout", async () => {
		const demux = createWorkerStdinDemux();
		demux.feed(`${specJson()}\n`);
		await demux.readSpec();

		try {
			await demux.awaitApproval("req-1", 50);
			throw new Error("expected reject");
		} catch (err) {
			ok(err instanceof Error && err.message.includes("timed out"));
		}
	});

	it("handles partial lines and multiple lines in one chunk", async () => {
		const demux = createWorkerStdinDemux();
		const specPromise = demux.readSpec();
		const text = specJson({ task: "b" });
		demux.feed(text.slice(0, 8));
		demux.feed(`${text.slice(8)}\n`);
		const spec = await specPromise;
		strictEqual(spec.task, "b");

		const r1 = demux.awaitApproval("r1");
		const r2 = demux.awaitApproval("r2");
		demux.feed(
			'{"type":"clio_tool_approval_response","payload":{"requestId":"r1","decision":"allow"}}\n{"type":"clio_tool_approval_response","payload":{"requestId":"r2","decision":"deny","reason":"no"}}\n',
		);
		strictEqual((await r1).decision, "allow");
		strictEqual((await r2).decision, "deny");
	});

	it("rejects an unknown worker spec version before approval routing starts", async () => {
		const demux = createWorkerStdinDemux();
		const specPromise = demux.readSpec();

		demux.feed(`${specJson({ specVersion: 999 })}\n`);

		await rejects(specPromise, /WorkerSpec version 999 is unsupported/);
	});

	it("rejects an unknown serialized runtime descriptor version", async () => {
		const demux = createWorkerStdinDemux();
		const specPromise = demux.readSpec();

		demux.feed(
			`${specJson({ runtime: { version: 999, id: "openai", kind: "http", apiFamily: "openai-responses", auth: "api-key" } })}\n`,
		);

		await rejects(specPromise, /WorkerSpec.runtime version 999 is unsupported/);
	});

	it("rejects malformed consumed spec fields before approval routing starts", async () => {
		const demux = createWorkerStdinDemux();
		const specPromise = demux.readSpec();

		demux.feed(`${specJson({ mode: "private-mode" })}\n`);

		await rejects(specPromise, /WorkerSpec.mode/);
	});
});
