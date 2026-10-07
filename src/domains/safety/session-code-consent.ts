/**
 * One operator consent per attended session for test runners (#377 follow-up).
 *
 * #377 lets recognized test runners run without an ask so an edit-then-test
 * loop has evidence. A test runner executes repository code unsandboxed under
 * the operator's account, and after the main agent writes `conftest.py`, a
 * test file or a Makefile, that code is the model's own. An attended session
 * therefore asks once, before the first test runner after it wrote or edited a
 * file; approving covers the rest of the session and a denial leaves the next
 * test runner asking again. Headless runs keep #377's allow (they deny every
 * ask), and workers and yolo are unchanged.
 */

/** The rail id the consent ask carries, so the card, the audit row and the approval note name it. */
export const SESSION_CODE_CONSENT_RULE_ID = "session-code-consent";

/** The rail as the card, the parked row and the grant row name it. */
export const SESSION_CODE_CONSENT_TEXT = "session test-runner consent";

export interface SessionCodeConsent {
	/** A main-session write, edit or artifact call succeeded. */
	noteWrite(): void;
	/** True when this session wrote a file and the operator has not consented yet. */
	pending(): boolean;
	/** The operator approved a consent ask. */
	grant(): void;
	/** The session was replaced or closed; the next one starts with neither. */
	reset(): void;
}

export function createSessionCodeConsent(): SessionCodeConsent {
	let wrote = false;
	let consented = false;
	return {
		noteWrite() {
			wrote = true;
		},
		pending: () => wrote && !consented,
		grant() {
			consented = true;
		},
		reset() {
			wrote = false;
			consented = false;
		},
	};
}
