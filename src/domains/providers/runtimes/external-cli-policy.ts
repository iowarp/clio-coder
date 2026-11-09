import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexSubprocessPermissionConfig {
	sandbox: "read-only" | "workspace-write";
}

/** The CLI owns its tools. Clio can constrain its sandbox mode, not park individual calls. */
export function codexSubprocessPermissionConfig(readOnly = false): CodexSubprocessPermissionConfig {
	return { sandbox: readOnly ? "read-only" : "workspace-write" };
}

export function opencodeCliMode(readOnly = false): "edit" {
	if (readOnly) {
		throw new Error(
			`opencode-cli runtime cannot enforce a read-only run through opencode run; choose ACP with an enforceable policy or an edit-capable run`,
		);
	}
	return "edit";
}

export function piCliMode(readOnly = false): "read-only" | "edit" {
	return readOnly ? "read-only" : "edit";
}

/** The credential variables OpenCode's own config names as `{env:NAME}`, which its CLI must be handed. */
export function referencedOpenCodeCredentials(sourceEnv: NodeJS.ProcessEnv): Record<string, string> {
	const configRoot =
		sourceEnv.OPENCODE_CONFIG_DIR ??
		join(sourceEnv.XDG_CONFIG_HOME ?? join(sourceEnv.HOME ?? homedir(), ".config"), "opencode");
	const paths = [sourceEnv.OPENCODE_CONFIG, join(configRoot, "opencode.json"), join(configRoot, "opencode.jsonc")];
	const forwarded: Record<string, string> = {};
	for (const path of paths) {
		if (path === undefined) continue;
		let content: string;
		try {
			if (statSync(path).size > 1024 * 1024) continue;
			content = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		for (const match of content.matchAll(/(?:["']apiKey["']|apiKey)\s*:\s*["']\{env:([A-Z_][A-Z0-9_]*)\}["']/gu)) {
			const name = match[1];
			if (name !== undefined && sourceEnv[name]) forwarded[name] = sourceEnv[name];
		}
	}
	return forwarded;
}
