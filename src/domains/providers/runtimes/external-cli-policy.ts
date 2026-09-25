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
