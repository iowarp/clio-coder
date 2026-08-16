import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { readSettings } from "../../src/core/config.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { initializeClioHome } from "../../src/core/init.js";
import { createInteropBundle } from "../../src/domains/interop/extension.js";
import type { InteropAgentId, InteropProposal, InteropReport } from "../../src/domains/interop/index.js";
import { writeInteropReport } from "../../src/domains/interop/index.js";
import type { Component, OverlayHandle, TUI } from "../../src/engine/tui.js";
import { interopOverlaySurface, openInteropOverlay } from "../../src/interactive/overlays/interop.js";
import type { SlashCommandContext } from "../../src/interactive/slash-commands.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

const FINGERPRINT = "sha256:a";

function proposal(): InteropProposal {
	return {
		kind: "codex",
		label: "Codex",
		fingerprint: FINGERPRINT,
		entry: { id: "codex", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"], toolGovernance: "clio-policy" },
		needsNetworkInstall: true,
	};
}

interface Surface {
	ctx: SlashCommandContext;
	accepted: InteropAgentId[];
	declined: InteropAgentId[];
}

/**
 * One detected, undecided ACP peer, and the two decisions the overlay takes
 * against it. Decisions land in this state the way the domain lands them on
 * disk, so the rows the overlay rebuilds are a projection of a real answer.
 */
function surface(): Surface {
	const accepted: InteropAgentId[] = [];
	const declined: InteropAgentId[] = [];
	const decided = (): boolean => accepted.length > 0 || declined.length > 0;
	const report = (): InteropReport => ({
		version: 1,
		detectedAt: "2026-08-16T00:00:00.000Z",
		agents: [
			{
				kind: "codex",
				presence: "present",
				binary: "/usr/local/bin/codex",
				adapter: "absent",
				skillCount: 0,
				projectArtifacts: 0,
				fingerprint: FINGERPRINT,
				...(declined.length > 0
					? { decision: "declined" as const, decidedAt: "2026-08-16T01:00:00.000Z", decidedFingerprint: FINGERPRINT }
					: {}),
			},
		],
	});
	const ctx = {
		interop: {
			report,
			proposals: () => (decided() ? [] : [proposal()]),
			configured: () =>
				accepted.length > 0 ? [{ id: "codex", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] }] : [],
			accept: (kind: InteropAgentId) => accepted.push(kind),
			decline: (kind: InteropAgentId) => declined.push(kind),
		},
	} as unknown as SlashCommandContext;
	return { ctx, accepted, declined };
}

interface Mounted {
	frame: Component;
	renders: number;
}

function open(ctx: SlashCommandContext): Mounted {
	let frame: Component | null = null;
	const state = { renders: 0 };
	const tui = {
		showOverlay(component: Component): OverlayHandle {
			frame = component;
			return {
				hide: () => undefined,
				setHidden: () => undefined,
				isHidden: () => false,
				focus: () => undefined,
				unfocus: () => undefined,
				isFocused: () => true,
			};
		},
		requestRender: () => {
			state.renders += 1;
		},
	} as unknown as TUI;
	openInteropOverlay(tui, ctx, () => undefined);
	if (frame === null) throw new Error("the interop overlay was not mounted");
	return {
		frame,
		get renders() {
			return state.renders;
		},
	};
}

function groups(frame: Component): string[] {
	return frame
		.render(120)
		.map(stripAnsi)
		.filter((line) => line.includes("──"))
		.map((line) => line.trim());
}

describe("contracts/interop overlay", () => {
	/**
	 * The decision was written to interop.json on the keystroke and the frame kept
	 * drawing the row under Detected until some other key moved the render memo,
	 * because the rebuild spliced the array the view was already holding.
	 */
	it("moves a declined row to Declined on the keystroke", () => {
		const { ctx, declined } = surface();
		const mounted = open(ctx);

		ok(
			groups(mounted.frame).some((line) => line.includes("Detected")),
			"the proposal starts under Detected",
		);

		mounted.frame.handleInput?.("d");

		strictEqual(declined.length, 1, "the first d must reach the action, not the filter box");
		const after = groups(mounted.frame);
		ok(
			after.some((line) => line.includes("Declined")),
			`the declined agent must be drawn as declined: ${after.join(" | ")}`,
		);
		ok(!after.some((line) => line.includes("Detected")), `and must leave the proposal list: ${after.join(" | ")}`);
	});

	it("moves an accepted row to Configured on the keystroke", () => {
		const { ctx, accepted } = surface();
		const mounted = open(ctx);
		groups(mounted.frame);

		mounted.frame.handleInput?.("a");

		strictEqual(accepted.length, 1);
		const after = groups(mounted.frame);
		ok(
			after.some((line) => line.includes("Configured")),
			`a connected agent must be drawn as connected: ${after.join(" | ")}`,
		);
		ok(!after.some((line) => line.includes("Detected")), after.join(" | "));
	});

	it("asks for the repaint rather than waiting for the next key", () => {
		const { ctx } = surface();
		const mounted = open(ctx);
		const before = mounted.renders;

		mounted.frame.handleInput?.("d");

		ok(mounted.renders > before, "a decision requests a render");
	});

	/**
	 * The same frame, over the real domain. Configured used to be read from the
	 * TUI's hot settings snapshot, which the config watcher refreshes a tick after
	 * the write, while the proposals were read from the file: an accepted agent
	 * left Detected on the keystroke and appeared under Configured only when the
	 * overlay was next opened.
	 */
	it("draws an accepted peer as Configured in the frame the keystroke asks for", () => {
		const scratch = isolateClioEnv("clio-interop-overlay-");
		try {
			initializeClioHome();
			writeInteropReport({
				version: 1,
				detectedAt: "2026-08-16T00:00:00.000Z",
				agents: [
					{
						kind: "codex",
						presence: "present",
						binary: "/usr/local/bin/codex",
						adapter: "absent",
						skillCount: 0,
						projectArtifacts: 0,
						fingerprint: FINGERPRINT,
					},
				],
			});
			const bundle = createInteropBundle({} as unknown as DomainContext);
			const ctx = {
				interop: interopOverlaySurface(bundle.contract, () => undefined),
			} as unknown as SlashCommandContext;
			const mounted = open(ctx);
			ok(
				groups(mounted.frame).some((line) => line.includes("Detected")),
				"the undecided peer starts as a proposal",
			);

			mounted.frame.handleInput?.("a");

			ok(
				readSettings().delegation.agents.some((agent) => agent.id === "codex"),
				"the accept wired the peer",
			);
			const after = groups(mounted.frame);
			ok(
				after.some((line) => line.includes("Configured")),
				`and the same frame draws it as connected: ${after.join(" | ")}`,
			);
			ok(!after.some((line) => line.includes("Detected")), after.join(" | "));
		} finally {
			scratch.restore();
		}
	});

	it("leaves a row alone when the key lands on a group that has no decision to take", () => {
		const { ctx, declined, accepted } = surface();
		const mounted = open(ctx);
		mounted.frame.handleInput?.("d");

		// The row is now under Declined, which is not a proposal: pressing the keys
		// again must not decide anything a second time.
		mounted.frame.handleInput?.("d");
		mounted.frame.handleInput?.("a");

		strictEqual(declined.length, 1);
		strictEqual(accepted.length, 0);
	});
});
