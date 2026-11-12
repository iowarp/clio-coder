import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { clioConfigPath } from "../../src/core/xdg.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import {
	compareHostVerificationBase,
	hostVerificationRejection,
	runHostVerification,
} from "../../src/domains/dispatch/host-verification.js";

process.env.CLIO_CODER_VERIFICATION_SLOT_DIR = mkdtempSync(join(tmpdir(), "clio-coder-verification-slot-"));

type ResolvedCheck = NonNullable<DispatchRequest["resolvedVerification"]>[number];

const scratches: string[] = [];

afterEach(() => {
	while (scratches.length > 0) {
		const dir = scratches.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

it("leaves the base not compared when the linked base tree cannot resolve the check's toolchain", {
	skip: !(sandboxAvailability().available && sandboxAvailability().backend === "bwrap"),
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-host-verification-base-"));
	scratches.push(root);
	const project = join(root, "project");
	const stateDir = join(root, "state");
	mkdirSync(join(project, "src"), { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(project, "package.json"), '{"devDependencies":{"@biomejs/biome":"1.0.0"}}\n');
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.name", "Host Verification Base");
	git(project, "config", "user.email", "host-verification@example.invalid");
	git(project, "add", "-A");
	git(project, "commit", "-q", "-m", "baseline");
	const base = git(project, "rev-parse", "HEAD").trim();
	const declared: ResolvedCheck = {
		check: "lint",
		cwd: project,
		timeoutMs: 5_000,
		argv: [process.execPath, "-e", "process.exit(1)"],
	};
	const request = {
		resolvedVerification: [declared],
		taskWorktree: { root: project, path: project, runId: "preflight", branch: "main", base, ownerToken: "fixture" },
	};
	const verification = await runHostVerification({ runId: "preflight", request, workerSuccessful: true, stateDir });
	ok(verification?.checks[0]);
	verification.checks[0].durationMs = 1;
	await compareHostVerificationBase({ verification, request, stateDir });
	strictEqual(verification.checks[0].baseComparison?.status, "not_compared");
	strictEqual(verification.checks[0].baseComparison?.reason, "the check could not start on the base");
	strictEqual(verification.status, "rejected");
	ok(!/also fails on base/u.test(hostVerificationRejection(verification)?.detail ?? ""));
	// A base that could not start is not a fact about the base, so it is never cached.
	strictEqual(existsSync(join(stateDir, "dispatch-verification-base")), false);
});

it("masks the workspace's secret files and Clio's settings from the base replay", {
	skip: !(sandboxAvailability().available && sandboxAvailability().backend === "bwrap"),
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-host-verification-base-"));
	scratches.push(root);
	const project = join(root, "project");
	const stateDir = join(root, "state");
	mkdirSync(project, { recursive: true });
	mkdirSync(clioConfigPath(), { recursive: true });
	const settings = join(clioConfigPath(), "settings.yaml");
	const env = join(project, ".env");
	writeFileSync(
		join(project, "check.js"),
		`for (const file of ${JSON.stringify([settings, env])}) { try { console.log(require("node:fs").readFileSync(file, "utf8")); } catch {} }\nprocess.exit(1);\n`,
	);
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.name", "Host Verification Base");
	git(project, "config", "user.email", "host-verification@example.invalid");
	git(project, "add", "-A");
	git(project, "commit", "-q", "-m", "baseline");
	const base = git(project, "rev-parse", "HEAD").trim();
	writeFileSync(settings, "settings-secret-marker\n");
	writeFileSync(env, "env-secret-marker\n");
	const request = {
		resolvedVerification: [{ check: "probe", cwd: project, timeoutMs: 10_000, argv: [process.execPath, "check.js"] }],
		taskWorktree: { root: project, path: project, runId: "masks", branch: "main", base, ownerToken: "fixture" },
	};
	const verification = await runHostVerification({ runId: "masks", request, workerSuccessful: true, stateDir });
	ok(verification?.checks[0]);
	await compareHostVerificationBase({ verification, request, stateDir });
	strictEqual(verification.checks[0].baseComparison?.status, "failed");
	const replays = join(stateDir, "dispatch-verification-base");
	const stored = readdirSync(replays).map((name) => readFileSync(join(replays, name), "utf8"));
	strictEqual(stored.length, 1);
	ok(!/secret-marker/u.test(stored.join("\n")), stored.join("\n"));
});
