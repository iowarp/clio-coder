import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { SafetyPolicyMetadata } from "../safety/policy-engine.js";
import type { RunReceiptReproducibility } from "./types.js";

export function collectReproducibilityMetadata(
	cwd: string,
	safety: SafetyPolicyMetadata | null,
): RunReceiptReproducibility {
	const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const commit = git(cwd, ["rev-parse", "HEAD"]);
	const status = git(cwd, ["status", "--short"]);
	const dirtyEntries = status === null ? null : status.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
	return {
		cwd,
		git: {
			branch,
			commit,
			dirty: dirtyEntries === null ? null : dirtyEntries > 0,
			dirtyEntries,
			statusHash: status === null ? null : sha256(status),
		},
		safetyPolicy: {
			version: safety?.version ?? 1,
			rulePackHash: safety?.rulePackHash ?? null,
			rulePackVersion: safety?.rulePackVersion ?? null,
			projectPolicyPath: safety?.projectPolicyPath ?? null,
			projectPolicyHash: safety?.projectPolicyHash ?? null,
			projectPolicyValid: safety?.projectPolicyValid ?? null,
			selfDev: safety?.selfDev ?? null,
		},
	};
}

function git(cwd: string, args: ReadonlyArray<string>): string | null {
	const result = spawnSync("git", [...args], {
		cwd,
		encoding: "utf8",
		timeout: 1000,
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return null;
	const trimmed = result.stdout.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function sha256(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}
