export interface CodexSubprocessPermissionConfig {
	sandbox: "read-only" | "workspace-write";
	dangerousBypass: boolean;
}

/** The CLI owns its tools. Clio can constrain its sandbox mode, not park individual calls. */
export function codexSubprocessPermissionConfigForAutonomy(readOnly = false): CodexSubprocessPermissionConfig {
	return { sandbox: readOnly ? "read-only" : "workspace-write", dangerousBypass: false };
}

export function opencodeCliModeForAutonomy(readOnly = false): "edit" {
	if (readOnly) {
		throw new Error(
			`opencode-cli runtime cannot enforce a read-only run through opencode run; choose ACP with an enforceable policy or an edit-capable run`,
		);
	}
	return "edit";
}

export function piCliModeForAutonomy(readOnly = false): "read-only" | "edit" {
	return readOnly ? "read-only" : "edit";
}
