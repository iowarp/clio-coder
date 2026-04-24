import { spawn } from "node:child_process";

import type { RuntimeDescriptor } from "../domains/providers/index.js";

export type NativeCliAuthState = "authenticated" | "unauthenticated" | "unknown" | "not-required";

export interface NativeCliAuthStatus {
	state: NativeCliAuthState;
	detail: string;
	exitCode: number;
}

interface NativeAuthSpec {
	binary: string;
	statusArgs?: string[];
	loginArgs?: string[];
	logoutArgs?: string[];
	loginGuidance: string;
	logoutGuidance?: string;
	authRequired: boolean;
	parseStatus?(result: NativeCommandResult): NativeCliAuthStatus;
}

interface NativeCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	error?: string;
}

export function nativeCliAuthSpec(runtime: RuntimeDescriptor): NativeAuthSpec | null {
	switch (runtime.id) {
		case "claude-code-sdk":
		case "claude-code-cli":
			return {
				binary: "claude",
				statusArgs: ["auth", "status"],
				loginArgs: ["auth", "login"],
				logoutArgs: ["auth", "logout"],
				loginGuidance: "claude auth login",
				logoutGuidance: "claude auth logout",
				authRequired: true,
				parseStatus: parseClaudeAuthStatus,
			};
		case "codex-cli":
			return {
				binary: "codex",
				loginGuidance: "codex login",
				logoutGuidance: "codex logout",
				authRequired: true,
			};
		case "gemini-cli":
			return {
				binary: "gemini",
				loginGuidance: "gemini auth login",
				authRequired: true,
			};
		case "copilot-cli":
			return {
				binary: "copilot",
				loginGuidance: "copilot auth login",
				authRequired: true,
			};
		case "opencode-cli":
			return {
				binary: "opencode",
				loginGuidance: "opencode auth login",
				authRequired: false,
			};
		default:
			return null;
	}
}

export async function nativeCliAuthStatus(runtime: RuntimeDescriptor): Promise<NativeCliAuthStatus> {
	const spec = nativeCliAuthSpec(runtime);
	if (!spec) {
		return { state: "not-required", detail: "no native CLI auth probe", exitCode: 0 };
	}
	if (!spec.authRequired && !spec.statusArgs) {
		return { state: "not-required", detail: "native CLI target can run without Clio credentials", exitCode: 0 };
	}
	if (!spec.statusArgs) {
		return {
			state: "unknown",
			detail: `native CLI auth status is not safely probeable; use \`${spec.loginGuidance}\` if needed`,
			exitCode: 1,
		};
	}
	const result = await runNativeCommand(spec.binary, spec.statusArgs, "pipe");
	if (spec.parseStatus) return spec.parseStatus(result);
	const text = `${result.stdout}\n${result.stderr}`.trim();
	return {
		state: result.exitCode === 0 ? "authenticated" : "unknown",
		detail: text || result.error || `exit ${result.exitCode}`,
		exitCode: result.exitCode === 0 ? 0 : 1,
	};
}

export async function runNativeCliLogin(runtime: RuntimeDescriptor, interactive: boolean): Promise<number> {
	const spec = nativeCliAuthSpec(runtime);
	if (!spec) {
		process.stderr.write(`runtime ${runtime.id} does not use native CLI auth\n`);
		return 1;
	}
	if (!spec.authRequired) {
		process.stdout.write(
			`runtime ${runtime.id} does not require Clio-managed auth; native command: ${spec.loginGuidance}\n`,
		);
		return 0;
	}
	if (!spec.loginArgs || !interactive) {
		process.stdout.write(
			`runtime ${runtime.id} uses native CLI authentication. Run \`${spec.loginGuidance}\` in a terminal; Clio will not store a credential for this runtime.\n`,
		);
		return 0;
	}
	process.stdout.write(`Starting native auth: ${spec.loginGuidance}\n`);
	return (await runNativeCommand(spec.binary, spec.loginArgs, "inherit")).exitCode;
}

export async function runNativeCliLogout(runtime: RuntimeDescriptor, interactive: boolean): Promise<number> {
	const spec = nativeCliAuthSpec(runtime);
	if (!spec) {
		process.stderr.write(`runtime ${runtime.id} does not use native CLI auth\n`);
		return 1;
	}
	if (!spec.logoutArgs || !interactive) {
		const command = spec.logoutGuidance ?? spec.loginGuidance;
		process.stdout.write(
			`runtime ${runtime.id} uses native CLI authentication. Run \`${command}\` in a terminal if you need to change native auth state; Clio has no stored credential to remove.\n`,
		);
		return 0;
	}
	process.stdout.write(
		`Starting native logout: ${spec.logoutGuidance ?? `${spec.binary} ${spec.logoutArgs.join(" ")}`}\n`,
	);
	return (await runNativeCommand(spec.binary, spec.logoutArgs, "inherit")).exitCode;
}

function parseClaudeAuthStatus(result: NativeCommandResult): NativeCliAuthStatus {
	const output = `${result.stdout}\n${result.stderr}`.trim();
	const lower = output.toLowerCase();
	if (result.error) {
		return { state: "unknown", detail: result.error, exitCode: 1 };
	}
	if (result.exitCode === 0 && !lower.includes("not logged in") && !lower.includes("unauth")) {
		return { state: "authenticated", detail: output || "claude auth status ok", exitCode: 0 };
	}
	if (lower.includes("not logged in") || lower.includes("unauth") || lower.includes("login required")) {
		return { state: "unauthenticated", detail: output || "claude auth login required", exitCode: 1 };
	}
	return {
		state: "unknown",
		detail: output || `claude auth status exited ${result.exitCode}`,
		exitCode: result.exitCode === 0 ? 0 : 1,
	};
}

function runNativeCommand(
	binary: string,
	args: ReadonlyArray<string>,
	stdio: "pipe" | "inherit",
): Promise<NativeCommandResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(binary, [...args], {
				stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({ exitCode: 1, stdout, stderr, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (stdio === "pipe") {
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
		}
		child.once("error", (error: Error) => {
			resolve({ exitCode: 1, stdout, stderr, error: error.message });
		});
		child.once("close", (code) => {
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}
