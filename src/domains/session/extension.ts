import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { performCheckpoint } from "./checkpoint.js";
import type { SessionContract, SessionMeta, TurnInput } from "./contract.js";
import { enrichForkMeta, listSessionsForCwd } from "./history.js";
import { type SessionManagerState, appendTurn, resumeSessionState, startSession } from "./manager.js";

/**
 * Session domain wire-up. Owns a single current SessionManagerState and
 * funnels create/append/checkpoint/resume/fork/close through the engine
 * session writer. The CLI drives lifecycle; the extension only enforces the
 * shutdown contract (final checkpoint + close) on domain stop.
 */
export function createSessionBundle(_context: DomainContext): DomainBundle<SessionContract> {
	let state: SessionManagerState | null = null;

	async function closeCurrent(): Promise<void> {
		if (!state) return;
		const s = state;
		state = null;
		await s.writer.close();
	}

	const contract: SessionContract = {
		current: () => state?.meta ?? null,
		create(input) {
			const cwd = input?.cwd ?? process.cwd();
			const startInput: { cwd: string; model?: string | null; provider?: string | null } = { cwd };
			if (input?.model !== undefined) startInput.model = input.model;
			if (input?.provider !== undefined) startInput.provider = input.provider;
			const next = startSession(startInput);
			state = next;
			return next.meta;
		},
		append(turn: TurnInput) {
			if (!state) throw new Error("session.append: no current session");
			return appendTurn(state, turn);
		},
		async checkpoint(reason) {
			if (!state) throw new Error("session.checkpoint: no current session");
			await performCheckpoint(state, reason);
		},
		resume(sessionId) {
			if (state && state.meta.id === sessionId) return state.meta;
			if (state) {
				// best-effort close of prior session before switching
				const prior = state;
				state = null;
				void prior.writer.close();
			}
			const next = resumeSessionState(sessionId);
			state = next;
			return next.meta;
		},
		fork(parentTurnId, input) {
			if (!state) throw new Error("session.fork: no current session to fork from");
			const parentMeta = state.meta;
			const prior = state;
			state = null;
			void prior.writer.close();

			const cwd = input?.cwd ?? parentMeta.cwd;
			const next = startSession({
				cwd,
				model: parentMeta.model,
				provider: parentMeta.provider,
			});
			enrichForkMeta(next.meta, parentMeta.id, parentTurnId);
			state = next;
			return next.meta;
		},
		history(): ReadonlyArray<SessionMeta> {
			const cwd = state?.meta.cwd ?? process.cwd();
			return listSessionsForCwd(cwd);
		},
		async close() {
			await closeCurrent();
		},
	};

	const extension: DomainExtension = {
		async start() {
			// Sessions are created lazily by the CLI; nothing to do on boot.
		},
		async stop() {
			if (!state) return;
			try {
				await performCheckpoint(state, "shutdown");
			} catch (err) {
				process.stderr.write(
					`[clio:session] shutdown checkpoint failed: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
			await closeCurrent();
		},
	};

	return { extension, contract };
}
