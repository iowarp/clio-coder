import { buildProjectTrustCard, type ProjectTrustCardModel, trustProjectCard } from "../cli/project-trust-card.js";

export const PROJECT_CONFIG_INACTIVE = "Project configuration not active · /trust";
export const PROJECT_CONFIG_PENDING_RESTART = "Project configuration trusted · restart Clio to apply it";

export interface ProjectTrustSessionDeps {
	cwd: () => string;
	/** Mount the card; `done(true)` is Trust all. False when another overlay holds the screen. */
	openCard: (model: ProjectTrustCardModel, done: (trusted: boolean) => void) => boolean;
	/** `/restart`, which refuses and says why while a turn or a dispatch is running. */
	restart: () => void;
	notice: (level: "info" | "warn", text: string) => void;
	/** The header reminder changed; ask for a frame. */
	onChange: () => void;
	/** Defers the first read off the boot path. Defaults to the next turn of the event loop. */
	schedule?: (run: () => void) => void;
}

export interface ProjectTrustSession {
	/** The header's line, or null when the project's configuration is active or absent. Never reads the disk. */
	reminder(): string | null;
	/** `/trust`: the card for whatever is untrusted now, or a notice that nothing is. */
	open(): void;
	/** After `/reload`: raise the card when a surface is new or changed since this session last declined it. */
	reloaded(): void;
}

/**
 * The in-session half of the project trust card. The launch card runs before the
 * session exists; this one is reached by `/trust` and by `/reload`, and keeps the
 * header honest about project configuration that is not applied.
 *
 * What is untrusted when the session starts counts as declined: the operator
 * either chose "Open without it" at launch or had no card to answer.
 */
export function createProjectTrustSession(deps: ProjectTrustSessionDeps): ProjectTrustSession {
	const declined = new Map<string, string | null>();
	let reminder: string | null = null;
	let pendingRestart = false;

	const read = (): ProjectTrustCardModel | null => {
		try {
			return buildProjectTrustCard(deps.cwd());
		} catch (error) {
			deps.notice(
				"warn",
				`Project configuration cannot be read: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	};
	const settle = (model: ProjectTrustCardModel | null): void => {
		const next = pendingRestart ? PROJECT_CONFIG_PENDING_RESTART : model === null ? null : PROJECT_CONFIG_INACTIVE;
		if (next === reminder) return;
		reminder = next;
		deps.onChange();
	};
	const decline = (model: ProjectTrustCardModel): void => {
		for (const item of model.surfaces) declined.set(item.surface, item.snapshot.contentHash);
	};
	const show = (model: ProjectTrustCardModel): void => {
		const opened = deps.openCard(model, (trusted) => {
			if (!trusted) {
				decline(model);
				return;
			}
			try {
				trustProjectCard(model);
			} catch (error) {
				deps.notice("warn", error instanceof Error ? error.message : String(error));
				return;
			}
			pendingRestart = true;
			settle(null);
			deps.notice("info", "Project configuration trusted · restarting to apply it");
			deps.restart();
		});
		if (!opened) deps.notice("warn", "Close the open panel first, then run /trust.");
	};

	(deps.schedule ?? ((run) => void setTimeout(run, 0).unref?.()))(() => {
		const model = read();
		if (model !== null) decline(model);
		settle(model);
	});

	return {
		reminder: () => reminder,
		open() {
			const model = read();
			settle(model);
			if (model === null) {
				deps.notice("info", "No project configuration is waiting for trust.");
				return;
			}
			show(model);
		},
		reloaded() {
			const model = read();
			settle(model);
			if (model === null) return;
			if (model.surfaces.some((item) => declined.get(item.surface) !== item.snapshot.contentHash)) show(model);
		},
	};
}
