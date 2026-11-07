/**
 * Whether the Copilot runtime this process starts may read the system keychain.
 *
 * A keychain read can raise an OS prompt (macOS "allow access"), so it is allowed only where an operator is
 * present to answer it: the interactive TUI, ACP (and the GUI, whose sessions run over ACP) and setup that can
 * ask the operator. Workers, headless `clio-coder run` and every other process never opt in, so the prompt
 * cannot hang them. The decision is module state, not an environment variable, so a spawned worker or
 * headless child never inherits it.
 */
let allowed = false;

/** The exact headless fix: a login the runtime can read with the keychain closed. Clio never signs in itself. */
export const COPILOT_HEADLESS_LOGIN_FIX =
	'run `gh auth login`, or add `"storeTokenPlaintext": true` to `settings.json` in the Copilot home (`COPILOT_HOME`, default `~/.copilot`) and run `copilot login` again';

/**
 * What a `copilot login` held only by the system keychain means, worded once so every doctor row that sees it
 * agrees: operator surfaces can use it, headless ones cannot, and the headless fix.
 */
export function copilotKeychainOnlyDetail(login: string): string {
	return `signed in as ${login} only through the system keychain: the TUI, ACP and the GUI can use it, but \`clio-coder run\`, fleet workers and other headless paths keep the keychain closed and see no login. For headless use, ${COPILOT_HEADLESS_LOGIN_FIX}`;
}

export function allowCopilotKeychain(): void {
	allowed = true;
}

export function copilotKeychainAllowed(): boolean {
	return allowed;
}
