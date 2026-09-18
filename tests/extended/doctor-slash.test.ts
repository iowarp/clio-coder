import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { collectDoctorFindings, doctorNotice } from "../../src/cli/doctor.js";
import type { LiveProbeOptions, ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import {
	BUILTIN_SLASH_COMMANDS,
	commandReference,
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

function context(overrides: Partial<SlashCommandContext>): {
	ctx: SlashCommandContext;
	notices: Array<[string, string]>;
	rendered: () => number;
} {
	const notices: Array<[string, string]> = [];
	let rendered = 0;
	const ctx = {
		notice: (level: string, text: string) => {
			notices.push([level, text]);
		},
		render: () => {
			rendered += 1;
		},
		...overrides,
	} as unknown as SlashCommandContext;
	return { ctx, notices, rendered: () => rendered };
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe("/doctor", () => {
	it("is registered with an optional deep mode and nothing else", () => {
		deepStrictEqual(parseSlashCommand("/doctor"), { kind: "doctor", deep: false });
		deepStrictEqual(parseSlashCommand("/doctor deep"), { kind: "doctor", deep: true });
		for (const input of ["/doctor fix", "/doctor deep extra"]) {
			strictEqual(parseSlashCommand(input).kind, "usage-error", input);
		}
		const reference = commandReference().find((entry) => entry.name === "doctor");
		strictEqual(reference?.group, "Inspect");
		match(reference?.usage ?? "", /\/doctor \[deep\]/);
		deepStrictEqual(BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "doctor")?.args?.positionals?.[0]?.values, [
			"deep",
		]);
	});

	it("renders the report the injected runner returns, at its level", async () => {
		const calls: Array<{ deep: boolean }> = [];
		const { ctx, notices, rendered } = context({
			runDoctor: async (options) => {
				calls.push(options);
				return { level: "warn", text: "doctor: 2 checks, 0 error(s), 1 warning(s)\nOK   a  b\nWARN c  d" };
			},
		});
		dispatchSlashCommand(parseSlashCommand("/doctor deep"), ctx);
		await settle();
		deepStrictEqual(calls, [{ deep: true }]);
		strictEqual(notices.length, 2);
		strictEqual(notices[0]?.[0], "info");
		match(notices[0]?.[1] ?? "", /deep checks/);
		deepStrictEqual(notices[1], ["warn", "doctor: 2 checks, 0 error(s), 1 warning(s)\nOK   a  b\nWARN c  d"]);
		strictEqual(rendered(), 1);
	});

	it("reports a runner failure and says so when the host has no runner", async () => {
		const failing = context({
			runDoctor: async () => {
				throw new Error("boom");
			},
		});
		dispatchSlashCommand(parseSlashCommand("/doctor"), failing.ctx);
		await settle();
		deepStrictEqual(failing.notices.at(-1), ["error", "doctor failed: boom"]);

		const unwired = context({});
		dispatchSlashCommand(parseSlashCommand("/doctor"), unwired.ctx);
		strictEqual(unwired.notices[0]?.[0], "error");
		match(unwired.notices[0]?.[1] ?? "", /not wired/);
	});

	it("heads the notice with a tally at the level of the worst row", () => {
		const warn = doctorNotice([
			{ ok: true, name: "a", detail: "fine" },
			{ ok: true, name: "b", level: "info", detail: "absent" },
			{ ok: true, name: "c", level: "warn", detail: "look" },
		]);
		strictEqual(warn.level, "warn");
		match(warn.text, /^doctor: 3 checks, 0 error\(s\), 1 warning\(s\)\nOK {3}a/);
		match(warn.text, /\nINFO b\s+absent\n/);
		strictEqual(doctorNotice([{ ok: false, name: "x", detail: "broken" }]).level, "error");
		strictEqual(doctorNotice([{ ok: true, name: "x", detail: "fine" }]).level, "success");
	});
});

describe("collectDoctorFindings with the session's providers", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("doctor-slash-");
	});
	afterEach(() => env.restore());

	function providers(status: Partial<TargetStatus>): { contract: ProvidersContract; probes: LiveProbeOptions[] } {
		const probes: LiveProbeOptions[] = [];
		const contract = {
			async probeAllLive(options?: LiveProbeOptions) {
				probes.push(options ?? {});
			},
			list: () => [status as TargetStatus],
		} as unknown as ProvidersContract;
		return { contract, probes };
	}

	it("runs the tool probe through the injected contract only for a deep run", async () => {
		const { contract, probes } = providers({
			target: { id: "session-target", runtime: "ollama" },
			available: true,
			reason: "",
			health: { status: "healthy" },
			toolProbe: {
				status: "failed",
				modelId: "m:latest",
				streamed: true,
				frames: 3,
				toolCall: false,
				argumentsValid: false,
				latencyMs: 12,
				checkedAt: 0,
				error: "no tool call in the stream",
			},
		} as unknown as Partial<TargetStatus>);

		const plain = await collectDoctorFindings({ deep: false });
		strictEqual(probes.length, 0);
		strictEqual(
			plain.some((f) => f.name.startsWith("tools ")),
			false,
		);

		const deep = await collectDoctorFindings({ deep: { providers: contract, toolsTimeoutMs: 5_000 } });
		deepStrictEqual(probes, [{ tools: true, toolsTimeoutMs: 5_000 }]);
		deepStrictEqual(
			deep.find((f) => f.name === "tools session-target"),
			{
				ok: true,
				name: "tools session-target",
				level: "warn",
				detail: "failed (m:latest): no tool call in the stream",
			},
		);
		ok(deep.some((f) => f.name === "toolchain python3"));
	});
});
