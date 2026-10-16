/**
 * One operator consent per attended session for test runners (#377 follow-up).
 *
 * #377 lets recognized test runners run without an ask so an edit-then-test
 * loop has evidence. A test runner executes repository code unsandboxed under
 * the operator's account, and whoever wrote that code (this session, an
 * earlier one, a worker, a git pull) is not something the host can know. So
 * the rule does not ask who wrote it: in an attended TUI or ACP session at
 * `default` autonomy the main agent's first test runner asks, approving covers
 * the rest of the session, and a denial leaves the next test runner asking
 * again. A headless `run` denies every ask, so it keeps #377's allow and never
 * asks. A trusted project safety command that names the exact command, and
 * yolo, still run it without asking; workers are unchanged.
 */

/** The rail id the consent ask carries, so the card, the audit row and the approval note name it. */
export const SESSION_CODE_CONSENT_RULE_ID = "session-code-consent";

/** The rail as the card, the parked row and the grant row name it. */
export const SESSION_CODE_CONSENT_TEXT = "session test-runner consent";

export interface SessionCodeConsent {
	/** True until the operator consents for this session; never true for a headless run. */
	pending(): boolean;
	/** The operator approved a consent ask. */
	grant(): void;
	/** The session was replaced or closed; the next one asks again. */
	reset(): void;
}

/** `headless` is a `clio-coder run` process, whose sessions keep #377's allow. */
export function createSessionCodeConsent(options: { headless?: boolean } = {}): SessionCodeConsent {
	const headless = options.headless === true;
	let consented = false;
	return {
		pending: () => !headless && !consented,
		grant() {
			consented = true;
		},
		reset() {
			consented = false;
		},
	};
}
