import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createMuxRuntime, type MuxPaneOpenFailure } from "../../src/domains/mux/contract.js";
import { createMuxClient, type MuxClient } from "../../src/domains/mux/socket-client.js";
import { MuxError } from "../../src/domains/mux/types.js";
import { createWatchPaneController } from "../../src/interactive/watch-pane.js";

function fixture() {
	const calls: string[] = [];
	let width = 200;
	let anchor = true;
	let failure: Error | null = null;
	const client = {
		async snapshot() {
			return { panes: [] };
		},
		async paneLayout() {
			return {
				tabId: "t1",
				panes: anchor ? [{ paneId: "self", rect: { x: 0, y: 0, width, height: 60 } }] : [],
				splits: [],
			};
		},
		async paneSplit() {
			calls.push("split");
			if (failure) throw failure;
			return { paneId: "watch", tabId: "t1", workspaceId: "w1" };
		},
		async paneRename() {},
		async paneReportMetadata() {},
		async paneSendText() {
			calls.push("send");
		},
		async paneClose() {
			calls.push("close");
		},
	} as unknown as MuxClient;
	const runtime = createMuxRuntime({
		client,
		detection: {
			mode: "guest",
			socketPath: null,
			server: { version: "0.8.2", protocol: 21 },
			self: { paneId: "self", tabId: "t1", workspaceId: "w1" },
			candidates: [],
			reason: "fixture",
			refused: false,
		},
	});
	const watch = () =>
		createWatchPaneController({
			mux: runtime.contract,
			getCwd: () => "/repo",
			selectionPath: "/fixture/watch-selection",
			dirs: { config: "/fixture/config", data: "/fixture/data", state: "/fixture/state", cache: "/fixture/cache" },
			command: () => ["viewer"],
			writeFile: () => {},
		});
	return {
		runtime,
		client,
		calls,
		watch,
		setWidth: (value: number) => {
			width = value;
		},
		setAnchor: (value: boolean) => {
			anchor = value;
		},
		setFailure: (value: Error | null) => {
			failure = value;
		},
	};
}

for (const [name, error, reason] of [
	[
		"structured error",
		{ code: "layout_capacity", message: "tab limit reached: 8 panes" },
		"cannot open the watch pane (kind=unknown, code=layout_capacity, method=pane.split): tab limit reached: 8 panes",
	],
	[
		"empty error",
		{},
		"cannot open the watch pane (kind=unknown, method=pane.split): no failure message was supplied by the pane host",
	],
	[
		"code-only error",
		{ code: "feature_disabled" },
		"cannot open the watch pane (kind=feature_disabled, code=feature_disabled, method=pane.split): no failure message was supplied by the pane host",
	],
	[
		"literal unknown message",
		{ message: "unknown" },
		"cannot open the watch pane (kind=unknown, method=pane.split): unknown",
	],
	[
		"literal unknown code and message",
		{ code: "unknown", message: "unknown" },
		"cannot open the watch pane (kind=unknown, code=unknown, method=pane.split): unknown",
	],
] as const) {
	it(`preserves ${name} through the real socket client, mux runtime, and watch result`, async () => {
		const root = mkdtempSync(join(tmpdir(), "watch-host-"));
		const socketPath = join(root, "host.sock");
		const methods: string[] = [];
		const server = createServer((socket) => {
			let pending = "";
			socket.on("data", (chunk) => {
				pending += chunk.toString();
				if (!pending.includes("\n")) return;
				const request = JSON.parse(pending.trim());
				methods.push(request.method);
				socket.end(`${JSON.stringify({ id: request.id, error })}\n`);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		const wire = createMuxClient({ socketPath });
		const f = fixture();
		f.client.paneSplit = wire.paneSplit;
		const controller = f.watch();
		try {
			deepStrictEqual(await controller.watch("run-1"), {
				status: "unavailable",
				reason,
			});
			strictEqual(controller.isOpen(), false);
			deepStrictEqual(methods, ["pane.split"]);
			deepStrictEqual(f.calls, []);
		} finally {
			controller.dispose();
			await wire.close();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			rmSync(root, { recursive: true, force: true });
		}
	});
}

it("keeps a structured refusal separate from a later independent successful watch", async () => {
	const f = fixture();
	f.setFailure(
		new MuxError("feature_disabled", "splits disabled by operator", {
			wireCode: "feature_disabled",
			method: "pane.split",
		}),
	);
	const controller = f.watch();
	const refused = await controller.watch("first");
	strictEqual(refused.status, "unavailable");
	if (refused.status !== "unavailable") return;
	match(refused.reason, /kind=feature_disabled, code=feature_disabled, method=pane.split/);
	match(refused.reason, /splits disabled by operator/);
	doesNotMatch(refused.reason, /capacity/);
	deepStrictEqual(f.calls, ["split"]);
	f.setFailure(null);
	deepStrictEqual(await controller.watch("second"), {
		status: "watching",
		runId: "second",
		paneId: "watch",
		opened: true,
	});
	deepStrictEqual(await controller.watch("third"), {
		status: "watching",
		runId: "third",
		paneId: "watch",
		opened: false,
	});
	deepStrictEqual(f.calls, ["split", "split", "send"]);
	controller.dispose();
});

for (const missing of [false, true]) {
	it(`reports local ${missing ? "missing anchor" : "minimum size"} refusal before any split`, async () => {
		const f = fixture();
		if (missing) f.setAnchor(false);
		else f.setWidth(80);
		const controller = f.watch();
		const result = await controller.watch("run");
		strictEqual(result.status, "unavailable");
		if (result.status !== "unavailable") return;
		match(result.reason, /locally:/);
		match(
			result.reason,
			missing
				? /no anchor geometry for self; check the pane host layout/
				: /needs 48 cells and at most half of 80 is available; enlarge the anchor pane/,
		);
		doesNotMatch(result.reason, /capacity|code=/);
		deepStrictEqual(f.calls, []);
		controller.dispose();
	});
}

it("explicitly reports a reason-free null without retaining a prior failure", async () => {
	const f = fixture();
	const original = f.runtime.contract.openUtilityPane;
	let first = true;
	f.runtime.contract.openUtilityPane = async (request) => {
		if (first) {
			first = false;
			return original(request);
		}
		return null;
	};
	f.setFailure(new MuxError("unknown", "old reason", { wireCode: "old_code" }));
	const controller = f.watch();
	await controller.watch("first");
	const result = await controller.watch("second");
	strictEqual(result.status, "unavailable");
	if (result.status !== "unavailable") return;
	strictEqual(
		result.reason,
		"cannot open the watch pane: no failure reason was supplied by the pane host; check /panes before trying again",
	);
	doesNotMatch(result.reason, /old reason|old_code|capacity/);
	deepStrictEqual(f.calls, ["split"]);
	controller.dispose();
});

it("keeps concurrent diagnostics request-scoped and legacy callers best-effort", async () => {
	const f = fixture();
	f.client.paneSplit = async (request) => {
		await new Promise<void>((resolve) => setImmediate(resolve));
		throw new MuxError("unknown", request.cwd ?? "", { wireCode: request.cwd ?? "", method: "pane.split" });
	};
	const failures: MuxPaneOpenFailure[][] = [[], []];
	deepStrictEqual(
		await Promise.all(
			failures.map((sink, index) =>
				f.runtime.contract.openUtilityPane({
					argv: [],
					cwd: `request-${index}`,
					label: "test",
					onFailure: (failure) => sink.push(failure),
				}),
			),
		),
		[null, null],
	);
	deepStrictEqual(
		failures.map((sink) => sink[0]),
		[0, 1].map((index) => ({
			source: "mux",
			kind: "unknown",
			wireCode: `request-${index}`,
			method: "pane.split",
			message: `request-${index}`,
		})),
	);
	strictEqual(await f.runtime.contract.openUtilityPane({ argv: [], cwd: "/repo", label: "legacy" }), null);
	strictEqual(
		await f.runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/repo",
			label: "throwing observer",
			onFailure: () => {
				throw new Error("observer");
			},
		}),
		null,
	);
});

it("retains structured fields even when the mux error message is empty", async () => {
	const f = fixture();
	f.setFailure(new MuxError("unknown", "", { wireCode: "unexplained_refusal", method: "pane.split" }));
	const controller = f.watch();
	deepStrictEqual(await controller.watch("run"), {
		status: "unavailable",
		reason:
			"cannot open the watch pane (kind=unknown, code=unexplained_refusal, method=pane.split): no failure message was supplied by the pane host",
	});
	deepStrictEqual(f.calls, ["split"]);
	controller.dispose();
});
