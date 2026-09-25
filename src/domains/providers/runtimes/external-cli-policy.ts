import type { AutonomyLevel } from "../../safety/autonomy.js";

export interface CodexSubprocessPermissionConfig {
	sandbox: "read-only" | "workspace-write" | "danger-full-access";
	dangerousBypass: boolean;
}

/** The CLI owns its tools. Clio can constrain its sandbox mode, not park individual calls. */
export function codexSubprocessPermissionConfigForAutonomy(
	level: AutonomyLevel | undefined,
	env: NodeJS.ProcessEnv = process.env,
): CodexSubprocessPermissionConfig {
	if (level === "read-only") return { sandbox: "read-only", dangerousBypass: false };
	if (level === "yolo" && env.CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS === "1") {
		return { sandbox: "danger-full-access", dangerousBypass: true };
	}
	return { sandbox: "workspace-write", dangerousBypass: false };
}

export function opencodeCliModeForAutonomy(level: AutonomyLevel | undefined): "edit" {
	if (level === "read-only") {
		throw new Error(
			`opencode-cli runtime cannot enforce autonomy '${level}' through opencode run; choose ACP with an enforceable policy or an edit-capable run`,
		);
	}
	return "edit";
}

export function piCliModeForAutonomy(level: AutonomyLevel | undefined): "read-only" | "edit" {
	return level === "read-only" ? "read-only" : "edit";
}
