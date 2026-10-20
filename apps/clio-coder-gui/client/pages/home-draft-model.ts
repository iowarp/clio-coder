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
	readonly workspaceId: string | null;
	readonly pending: FirstRequest | null;
}

export const EMPTY_HOME_DRAFT: HomeDraft = { version: 1, revision: 0, text: "", workspaceId: null, pending: null };
const id = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);

/** Storage is untrusted and optional. Restore the body, identity and scope as one bounded record. */
export function decodeHomeDraft(raw: string | null): HomeDraft {
	if (!raw || raw.length > 500_000) return EMPTY_HOME_DRAFT;
	try {
		const value = JSON.parse(raw) as Partial<HomeDraft> | null;
		if (value?.version !== 1 || typeof value.text !== "string" || value.text.length > 100_000) return EMPTY_HOME_DRAFT;
		if (!Number.isSafeInteger(value.revision) || (value.revision ?? -1) < 0) return EMPTY_HOME_DRAFT;
		if (value.workspaceId !== null && !id(value.workspaceId)) return EMPTY_HOME_DRAFT;
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
		return {
			version: 1,
			revision: value.revision as number,
			text: value.text,
			workspaceId: value.workspaceId,
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
	return { ...draft, text: draft.revision === sent.draftRevision ? "" : draft.text, pending: null };
}
