/** The first request belongs to one tab, independently of the page that currently shows it. */
export interface FirstRequest {
	readonly workspaceId: string;
	readonly exactTurnBody: { readonly text: string };
	readonly epoch: string;
	readonly createKey: string;
	readonly turnKey: string;
	readonly sessionId: string | null;
	readonly phase: "creating" | "created" | "submitting";
	readonly draftRevision: number;
}

export interface HomeDraft {
	readonly version: 1;
	readonly revision: number;
	readonly text: string;
	readonly textIssue: "too-large" | "restored-too-large" | "invalid" | null;
	readonly workspaceId: string | null;
	readonly pending: FirstRequest | null;
}

export const HOME_DRAFT_TEXT_MAX_CHARACTERS = 100_000;
export const EMPTY_HOME_DRAFT: HomeDraft = {
	version: 1,
	revision: 0,
	text: "",
	textIssue: null,
	workspaceId: null,
	pending: null,
};
const id = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);

/** Storage is untrusted and optional. Editable text must never invalidate a sound pending command. */
export function decodeHomeDraft(raw: string | null): HomeDraft {
	if (!raw) return EMPTY_HOME_DRAFT;
	try {
		const value = JSON.parse(raw) as Partial<HomeDraft> | null;
		if (value?.version !== 1) return EMPTY_HOME_DRAFT;
		const request = value.pending;
		if (
			request !== null &&
			(!request ||
				!id(request.workspaceId) ||
				!id(request.epoch) ||
				!id(request.createKey) ||
				!id(request.turnKey) ||
				(request.sessionId !== null && !id(request.sessionId)) ||
				!["creating", "created", "submitting"].includes(request.phase) ||
				(request.phase !== "creating" && request.sessionId === null) ||
				!Number.isSafeInteger(request.draftRevision) ||
				request.draftRevision < 0 ||
				typeof request.exactTurnBody?.text !== "string" ||
				!request.exactTurnBody.text.trim() ||
				request.exactTurnBody.text.length > 32_000)
		)
			return EMPTY_HOME_DRAFT;
		const textIssue =
			typeof value.text !== "string"
				? "invalid"
				: value.text.length > HOME_DRAFT_TEXT_MAX_CHARACTERS
					? "restored-too-large"
					: value.textIssue === "too-large" || value.textIssue === "restored-too-large" || value.textIssue === "invalid"
						? value.textIssue
						: null;
		const validRevision = Number.isSafeInteger(value.revision) && (value.revision ?? -1) >= 0;
		let revision = validRevision ? (value.revision as number) : 0;
		// Repaired editor data cannot be treated as the unchanged submitted draft by a later acknowledgement.
		if (request && (textIssue || !validRevision || revision < request.draftRevision))
			revision = Math.min(Math.max(revision, request.draftRevision) + 1, Number.MAX_SAFE_INTEGER);
		return {
			version: 1,
			revision,
			text: typeof value.text === "string" ? value.text.slice(0, HOME_DRAFT_TEXT_MAX_CHARACTERS) : "",
			textIssue,
			workspaceId: id(value.workspaceId) ? value.workspaceId : (request?.workspaceId ?? null),
			pending: request
				? {
						workspaceId: request.workspaceId,
						epoch: request.epoch,
						createKey: request.createKey,
						turnKey: request.turnKey,
						sessionId: request.sessionId,
						phase: request.phase,
						draftRevision: request.draftRevision,
						exactTurnBody: { text: request.exactTurnBody.text },
					}
				: null,
		};
	} catch {
		return EMPTY_HOME_DRAFT;
	}
}

/** Confirmation of an older send must leave subsequent edits and workspace choices intact. */
export function acknowledgeFirstRequest(draft: HomeDraft, sent: FirstRequest): HomeDraft {
	if (draft.pending?.turnKey !== sent.turnKey) return draft;
	return {
		...draft,
		// A saturated or repaired counter cannot establish that no newer edit occurred.
		text: draft.revision < Number.MAX_SAFE_INTEGER && draft.revision === sent.draftRevision ? "" : draft.text,
		pending: null,
	};
}
