import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { ApiProblem, type Client, emptyInput } from "../api/client.js";
import { PROMPT_TEXT_MAX_CHARACTERS } from "../chat/composer-model.js";

export interface HomeProject {
	id: string | null;
	path: string;
}

/** One explicit launch, with stable keys for an unchanged retry after an uncertain response. */
export class HomeLaunch {
	#attempt: {
		project: string;
		openKey: string;
		sessionKey: string;
		workspaceId?: string;
		session?: SessionSnapshot;
		turn?: { text: string; key: string };
	} | null = null;
	#pending: Promise<SessionSnapshot> | null = null;

	constructor(private readonly client: Client) {}

	get session(): SessionSnapshot | null {
		return this.#attempt?.session ?? null;
	}

	start(project: HomeProject, text: string): Promise<SessionSnapshot> {
		if (this.#pending) return this.#pending;
		const path = project.path.trim();
		if (!project.id && !path) return Promise.reject(new Error("Choose a project before starting."));
		const prompt = text.trim();
		if (prompt.length > PROMPT_TEXT_MAX_CHARACTERS)
			return Promise.reject(new Error("Shorten this message to 32,000 characters before sending."));
		const identity = project.id ?? path;
		if (this.#attempt?.project !== identity)
			this.#attempt = { project: identity, openKey: crypto.randomUUID(), sessionKey: crypto.randomUUID() };
		const attempt = this.#attempt;
		this.#pending = (async () => {
			attempt.workspaceId ??=
				project.id ?? (await this.client.call(routes.openWorkspace, { ...emptyInput, body: { path } }, attempt.openKey)).id;
			attempt.session ??= await this.client.call(
				routes.newSession,
				{ params: { id: attempt.workspaceId }, query: {}, body: {} },
				attempt.sessionKey,
			);
			if (prompt) {
				if (attempt.turn?.text !== prompt) attempt.turn = { text: prompt, key: crypto.randomUUID() };
				try {
					await this.client.call(
						routes.turn,
						{ params: { id: attempt.session.id }, query: {}, body: { text: prompt } },
						attempt.turn.key,
					);
				} catch (error) {
					// A definite refusal accepted no turn. A lost response keeps its key for a safe retry.
					if (error instanceof ApiProblem && [400, 409].includes(error.problem.status)) delete attempt.turn;
					throw error;
				}
			}
			return attempt.session;
		})().finally(() => {
			this.#pending = null;
		});
		return this.#pending;
	}
}
