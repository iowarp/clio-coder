import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	formatToolApprovalRequest,
	routeToolApprovalOverlayKey,
} from "../../src/interactive/overlays/tool-approval-overlay.js";
import { makeScratchHome, spawnClioPty } from "../harness/pty.js";

function writeClaudeSdkWorkerFixture(configDir: string): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "settings.yaml"),
		[
			"version: 1",
			"identity: clio",
			"defaultMode: default",
			"safetyLevel: auto-edit",
			"targets:",
			"  - id: claude-sdk-faux",
			"    runtime: claude-code-sdk",
			"    defaultModel: claude-sonnet-4-6",
			"orchestrator:",
			"  target: claude-sdk-faux",
			"  model: claude-sonnet-4-6",
			"  thinkingLevel: off",
			"workers:",
			"  default:",
			"    target: claude-sdk-faux",
			"    model: claude-sonnet-4-6",
			"    thinkingLevel: off",
			"  profiles: {}",
			"scope: []",
			"budget:",
			"  sessionCeilingUsd: 5",
			"  concurrency: auto",
			"theme: default",
			"keybindings: {}",
			"state:",
			"  lastMode: default",
			"compaction:",
			"  threshold: 0.8",
			"  auto: true",
			"",
		].join("\n"),
		"utf8",
	);
}

describe("interactive tool-approval overlay", () => {
	it("formats approval requests and resolves allow or deny keys", () => {
		const request = {
			requestId: "approval-1",
			claudeToolName: "MysteryTool",
			clioToolName: null,
			args: { path: "package.json", nested: { value: 1 } },
			classification: { actionClass: "unknown", reasons: ["unmapped or specially-routed Claude tool"] },
			mode: "default",
		};
		const lines = formatToolApprovalRequest(request);
		ok(lines.some((line) => line.includes("MysteryTool")));
		ok(lines.some((line) => line.includes("Safety classification: unknown")));

		const decisions: Array<{ decision: "allow" | "deny"; reason: string }> = [];
		const deps = {
			resolve(decision: "allow" | "deny", reason: string) {
				decisions.push({ decision, reason });
			},
		};
		strictEqual(routeToolApprovalOverlayKey("a", deps), true);
		strictEqual(routeToolApprovalOverlayKey("D", deps), true);
		strictEqual(routeToolApprovalOverlayKey("\u001b", deps), true);
		strictEqual(decisions.map((entry) => entry.decision).join(","), "allow,deny,deny");
	});

	it("opens the overlay when a worker emits an approval request and A allows", async () => {
		const scratch = makeScratchHome();
		let p: ReturnType<typeof spawnClioPty> | null = null;
		try {
			writeClaudeSdkWorkerFixture(scratch.env.CLIO_CONFIG_DIR ?? scratch.dir);
			p = spawnClioPty({
				env: {
					...scratch.env,
					CLIO_CLAUDE_SDK_FAUX_ASK: "1",
				},
			});
			await p.expect(/CLIO::CODER/, 15_000);
			p.send("/run worker trigger ask\r");
			await p.expect(/Tool approval/, 20_000);
			p.send("a");
			await p.expect(/\[run\] done exit=0/, 30_000);
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p?.kill();
			scratch.cleanup();
		}
	});
});
