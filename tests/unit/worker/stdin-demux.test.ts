import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkerStdinDemux } from "../../../src/worker/stdin-demux.js";

describe("worker/stdin-demux", () => {
	it("delivers the first line as the spec and routes responses to pending approvals", async () => {
		const demux = createWorkerStdinDemux();
		const specPromise = demux.readSpec();

		demux.feed('{"agentId":"x","task":"y"}\n');
		const spec = await specPromise;
		const parsedSpec = spec as unknown as { agentId?: string; task?: string };
		ok(parsedSpec.agentId === "x" && parsedSpec.task === "y", `spec=${JSON.stringify(spec)}`);

		const responsePromise = demux.awaitApproval("req-1", 1000);
		demux.feed('{"type":"clio_tool_approval_response","payload":{"requestId":"req-1","decision":"allow"}}\n');
		const response = await responsePromise;
		strictEqual(response.decision, "allow");
	});

	it("rejects awaitApproval when stdin EOFs before a response", async () => {
		const demux = createWorkerStdinDemux();
		demux.feed("{}\n");
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
		demux.feed("{}\n");
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
		demux.feed('{"agen');
		demux.feed('tId":"a","task":"b"}\n');
		const spec = await specPromise;
		strictEqual((spec as unknown as { agentId?: string }).agentId, "a");

		const r1 = demux.awaitApproval("r1");
		const r2 = demux.awaitApproval("r2");
		demux.feed(
			'{"type":"clio_tool_approval_response","payload":{"requestId":"r1","decision":"allow"}}\n{"type":"clio_tool_approval_response","payload":{"requestId":"r2","decision":"deny","reason":"no"}}\n',
		);
		strictEqual((await r1).decision, "allow");
		strictEqual((await r2).decision, "deny");
	});
});
