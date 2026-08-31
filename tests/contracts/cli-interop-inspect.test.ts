/**
 * `clio-coder interop inspect --json`, the fixed read a GUI host may run.
 *
 * Detection resolves a foreign agent's binary on PATH and finds the directory
 * it owns under the operator's home. Neither path crosses this boundary; what
 * does is whether the agent is there, how far it is wired, and whether the
 * operator's standing answer still holds. The read also runs no foreign
 * executable, so a GUI refresh cannot become "execute every coding agent
 * installed on this machine".
 *
 * Every case stubs its own PATH and HOME, so detection resolves against files
 * this test wrote rather than against whichever coding agents the machine
 * running the suite happens to have installed.
 */

import { ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { interopInspectSnapshot, runInteropInspect } from "../../src/cli/interop-inspect.js";
import {
	detectInteropAgents,
	INTEROP_AGENT_KINDS,
	type InteropAgentId,
	interopAgentKind,
	writeInteropReport,
} from "../../src/domains/interop/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const AT = "2026-08-31T12:00:00.000Z";

/**
 * Put one agent's executable on a PATH holding nothing else.
 *
 * The stub is never run: this read does not probe versions, which is one of the
 * properties under test. What it establishes is that the binary resolves, which
 * is what makes the agent detected at all.
 */
function stubAgentBinary(dir: string, id: InteropAgentId): string {
	const kind = interopAgentKind(id);
	ok(kind !== undefined);
	const name = kind.binaryNames[0];
	ok(name !== undefined, `${id} must declare a binary to stub`);
	const binDir = join(dir, "bin");
	mkdirSync(binDir, { recursive: true });
	const binary = join(binDir, name);
	writeFileSync(binary, "#!/bin/sh\nexit 1\n");
	chmodSync(binary, 0o755);
	process.env.PATH = binDir;
	process.env.HOME = join(dir, "home");
	mkdirSync(process.env.HOME, { recursive: true });
	return binary;
}

/**
 * Record a standing decision the way accepting or declining one does: against
 * the fingerprint detection actually computes for the facts on disk. Writing an
 * arbitrary fingerprint would make every decision read as stale, which is the
 * opposite of what most of these cases are checking.
 */
async function seed(
	dir: string,
	id: InteropAgentId,
	options: { decision?: "accepted" | "declined"; version?: string; staleDecision?: boolean } = {},
): Promise<void> {
	stubAgentBinary(dir, id);
	// Two passes, because the fingerprint covers the version. The first pass
	// records the version the harness would have observed, and the second gets
	// the fingerprint that fact produces, which is the one a real accept or
	// decline is keyed by.
	const first = await detectInteropAgents({ cwd: dir, probeVersion: false });
	writeInteropReport({
		version: 1,
		detectedAt: first.detectedAt,
		agents: first.agents.map((agent) =>
			agent.kind === id && options.version !== undefined ? { ...agent, version: options.version } : agent,
		),
	});
	const settled = await detectInteropAgents({ cwd: dir, probeVersion: false });
	writeInteropReport({
		version: 1,
		detectedAt: settled.detectedAt,
		agents: settled.agents.map((agent) =>
			agent.kind !== id || options.decision === undefined
				? agent
				: {
						...agent,
						decision: options.decision,
						decidedAt: "2026-08-20T20:31:58.391Z",
						decidedFingerprint: options.staleDecision === true ? "sha256:taken-against-older-facts" : agent.fingerprint,
					},
		),
	});
}

describe("interop inspect projection", () => {
	it("reports how far an agent is wired without its binary or home directory", async () => {
		const scratch = await isolateClioEnv();
		try {
			await seed(scratch.dir, "claude-code", { decision: "accepted", version: "2.1.237" });

			const snapshot = await interopInspectSnapshot(() => Date.parse(AT));
			strictEqual(snapshot.knownKinds, INTEROP_AGENT_KINDS.length);
			const agent = snapshot.agents.find((entry) => entry.id === "claude-code");
			ok(agent !== undefined, "the stubbed agent must reach the projection");
			strictEqual(agent.label, "Claude Code");
			strictEqual(agent.presence, "present");
			strictEqual(agent.acp, true);
			// The version is the last one the harness observed for this binary, kept
			// across a non-probing detection, so it crosses without running anything.
			strictEqual(agent.version, "2.1.237");
			strictEqual(agent.decision, "accepted");
			strictEqual(agent.decidedAt, "2026-08-20T20:31:58.391Z");
			strictEqual(agent.decisionStale, false);
			// The resolved binary, the scratch root, and the keying fingerprint are
			// all host-side facts.
			const serialized = JSON.stringify(snapshot);
			strictEqual(serialized.includes(scratch.dir), false);
			strictEqual(serialized.includes("sha256:"), false);
		} finally {
			scratch.restore();
		}
	});

	it("says a standing answer went stale when the facts moved under it", async () => {
		const scratch = await isolateClioEnv();
		try {
			await seed(scratch.dir, "codex", { decision: "declined", staleDecision: true });

			const agent = (await interopInspectSnapshot(() => Date.parse(AT))).agents.find((entry) => entry.id === "codex");
			ok(agent !== undefined);
			strictEqual(agent.decision, "declined");
			// A standing answer suppresses re-proposal only while the facts it was
			// made against still hold, so a stale one is offered again.
			strictEqual(agent.decisionStale, true);
			strictEqual(agent.proposed, true);
		} finally {
			scratch.restore();
		}
	});

	it("offers an agent the operator has never been asked about", async () => {
		const scratch = await isolateClioEnv();
		try {
			await seed(scratch.dir, "opencode");

			const agent = (await interopInspectSnapshot(() => Date.parse(AT))).agents.find((entry) => entry.id === "opencode");
			ok(agent !== undefined);
			strictEqual(agent.decision, null);
			strictEqual(agent.decidedAt, null);
			strictEqual(agent.decisionStale, false);
			strictEqual(agent.configured, false);
			strictEqual(agent.proposed, true);
		} finally {
			scratch.restore();
		}
	});

	it("holds the invariants a detected record cannot violate", async () => {
		const scratch = await isolateClioEnv();
		try {
			await seed(scratch.dir, "opencode", { decision: "accepted" });
			const snapshot = await interopInspectSnapshot(() => Date.parse(AT));
			ok(snapshot.agents.length > 0, "the stubbed agent must be detected");
			for (const agent of snapshot.agents) {
				// Only a kind with an ACP recipe has an adapter to report.
				strictEqual(agent.acp, agent.adapter !== null, `${agent.id} adapter must track its recipe`);
				// A decision stamp exists exactly when a decision does.
				strictEqual(agent.decision !== null, agent.decidedAt !== null, `${agent.id} decision stamp`);
				if (agent.decisionStale) ok(agent.decision !== null, `${agent.id} stale decision needs a decision`);
				// Only a present ACP agent that is neither wired nor settled is offered.
				if (agent.proposed) {
					strictEqual(agent.presence, "present");
					strictEqual(agent.acp, true);
					strictEqual(agent.configured, false);
				}
				// Only an ACP kind can need a network install.
				if (agent.needsNetworkInstall) strictEqual(agent.acp, true);
			}
		} finally {
			scratch.restore();
		}
	});

	it("emits nothing but a usage error for any argv other than the fixed one", async () => {
		const scratch = await isolateClioEnv();
		try {
			const written: string[] = [];
			const original = process.stderr.write.bind(process.stderr);
			process.stderr.write = ((chunk: string) => {
				written.push(String(chunk));
				return true;
			}) as typeof process.stderr.write;
			try {
				strictEqual(await runInteropInspect([]), 2);
				strictEqual(await runInteropInspect(["--json", "--all"]), 2);
				strictEqual(await runInteropInspect(["claude-code"]), 2);
			} finally {
				process.stderr.write = original;
			}
			strictEqual(written.length, 3);
			ok(written.every((line) => line.includes("usage:")));
		} finally {
			scratch.restore();
		}
	});
});
