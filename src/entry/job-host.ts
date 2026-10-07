import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { JobOwner, JobRecord } from "../core/job-types.js";
import { captureProjectSurface } from "../core/workspace-trust.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import { createJobController, createJobStore } from "../domains/scheduling/index.js";
import type { JobExecutionContext, JobStore } from "../domains/scheduling/job-types.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { ChatLoop } from "../session-control/chat-loop.js";
import { createJobTool } from "../tools/job.js";
import type { JobOperations } from "../tools/job-types.js";
import type { ToolRegistry, ToolSpec } from "../tools/registry.js";
import { createJobRuntime, jobAuthorityRefusal } from "./job-runtime.js";

export interface JobHostDeps {
	registry: ToolRegistry;
	bus: SafeEventBus;
	session?: Pick<SessionContract, "current" | "create">;
	cwd: string;
	/** A transient `run` host cannot promise future occurrences (#411). */
	attended: boolean;
	safety: SafetyContract;
	autonomy(): AutonomyLevel;
	/** The session's test-runner consent is owed; a job command is admitted as its direct call would be. */
	sessionCodeConsentPending?(): boolean;
	createSession(): void;
	notice(text: string): void;
	store?: JobStore;
}

export interface JobHost {
	tool: ToolSpec;
	operations: JobOperations;
	attachChat(chat: ChatLoop): void;
	close(): Promise<void>;
}

/** One controller lifetime belongs to one parent process and its current conversation (#411). */
export function createJobHost(deps: JobHostDeps): JobHost {
	const cwd = realpathSync(deps.cwd);
	let chat: ChatLoop | null = null;
	let current: JobOwner | null = null;
	let parkedSession: string | null = null;
	let closed = false;
	let closing: Promise<void> | null = null;
	let detachChat = (): void => {};
	const retiring = new Set<Promise<void>>();
	const listeners = new Set<(job: JobRecord) => void>();
	const hostRefusal = (): string | null =>
		closed
			? "job: this conversation host is closing; open a new attended conversation."
			: !deps.attended
				? "job: clio-coder run exits after one turn and cannot own recurring jobs. Create the job in an attended terminal or an ACP conversation that stays open."
				: !deps.session
					? "job: this host has no persistent conversation session; use an attended terminal or ACP conversation."
					: null;
	const isCurrent = (owner: JobOwner): boolean => {
		if (
			closed ||
			parkedSession !== null ||
			current === null ||
			owner.sessionId !== current.sessionId ||
			owner.generation !== current.generation ||
			owner.cwd !== cwd
		)
			return false;
		const meta = deps.session?.current();
		try {
			return meta?.id === owner.sessionId && realpathSync(meta.cwd) === cwd && realpathSync(deps.cwd) === cwd;
		} catch {
			return false; /* A removed/replaced workspace cannot retain admission (#411). */
		}
	};
	const retireCurrent = (reason: string): void => {
		const owner = current;
		current = null;
		if (owner === null) return;
		const operation = controller.retire(owner, reason);
		retiring.add(operation);
		void operation.then(
			() => retiring.delete(operation),
			(error: unknown) => {
				retiring.delete(operation);
				deps.notice(`job: ${error instanceof Error ? error.message : String(error)}`);
			},
		);
	};
	const owner = (create = false): JobOwner | null => {
		if (closed || !deps.session) return null;
		if (create && !deps.session.current() && hostRefusal() === null) deps.createSession();
		const meta = deps.session.current();
		if (!meta || parkedSession === meta.id) return null;
		const canonical = realpathSync(meta.cwd);
		if (canonical !== cwd)
			throw new Error(
				"job: the current conversation cwd differs from this process's canonical workspace; open a host in that workspace.",
			);
		if (current?.sessionId !== meta.id) {
			retireCurrent("creator conversation replaced");
			current = { sessionId: meta.id, cwd, generation: randomUUID() };
			controller.recover(current);
		}
		return current;
	};
	const runtimeDeps = {
		chat: () => chat,
		isCurrent,
		constraints: () => chat?.jobConstraints?.() ?? chat?.currentTurnConstraints?.(),
		safety: deps.safety,
		autonomy: deps.autonomy,
		...(deps.sessionCodeConsentPending !== undefined
			? { sessionCodeConsentPending: deps.sessionCodeConsentPending }
			: {}),
		hostRefusal,
		trustRefusal: (): string | null => {
			for (const surface of ["safety", "settings", "hooks", "extensions", "plugins"] as const) {
				const snapshot = captureProjectSurface(cwd, surface);
				if (snapshot.verdict !== "trusted" && snapshot.files.some((file) => file.text !== null || file.error !== undefined))
					return `Project ${surface} trust is ${snapshot.verdict}; review and trust its current bytes before creating or resuming jobs.`;
			}
			return null;
		},
		permissionPending: () => deps.registry.hasParkedCalls(),
		runCommand: (context: JobExecutionContext) => tool.runCommand(context),
		notice: deps.notice,
	};
	const controller = createJobController({
		ports: createJobRuntime(runtimeDeps),
		store: deps.store ?? createJobStore(),
		onChange(payload) {
			deps.bus.emit(BusChannels.JobChanged, payload);
			const meta = deps.session?.current();
			if (meta?.id !== payload.job.owner.sessionId || payload.job.owner.cwd !== cwd) return;
			for (const listener of [...listeners]) {
				try {
					listener(structuredClone(payload.job));
				} catch (error) {
					deps.notice(`job observer: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		},
		onError: (error) => deps.notice(`job: ${error.message}`),
	});
	const tool = createJobTool({
		controller,
		registry: deps.registry,
		owner,
		constraints: runtimeDeps.constraints,
		hostRefusal,
		admissionRefusal: (runner, creator, constraints) => jobAuthorityRefusal(runtimeDeps, creator, runner, constraints),
	});
	const subscriptions = [
		deps.bus.on(BusChannels.SessionParked, ({ sessionId, reason }) => {
			if (current?.sessionId !== sessionId) return;
			parkedSession = sessionId;
			retireCurrent(reason);
		}),
		deps.bus.on(BusChannels.SessionResumed, () => {
			parkedSession = null;
			retireCurrent("conversation resumed");
		}),
		deps.bus.on(BusChannels.SessionTurnSwitched, () => {
			parkedSession = null;
			retireCurrent("conversation branch changed");
		}),
	];
	const operations: JobOperations = {
		async invoke(args, options) {
			try {
				if (options?.sessionId !== undefined && options.sessionId !== deps.session?.current()?.id)
					return { kind: "error", message: "job: command session does not match the current creator conversation." };
				return await tool.invoke(args, options);
			} catch (error) {
				return { kind: "error", message: `job: ${error instanceof Error ? error.message : String(error)}` };
			}
		},
		list() {
			const scope = owner();
			return scope === null ? [] : controller.list(scope);
		},
		status(id) {
			const scope = owner();
			return scope === null ? null : controller.get(id, scope);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return {
		tool: tool.spec,
		operations,
		attachChat(attached) {
			detachChat();
			chat = attached;
			detachChat =
				attached.onSessionReset?.(() => {
					// Shell completion refreshes this transcript too; canonical branch navigation emits its own bus edge (#411).
					if (current !== null && !isCurrent(current)) retireCurrent("creator conversation changed");
				}) ?? (() => {});
			owner();
		},
		close() {
			if (closing) return closing;
			closed = true;
			detachChat();
			for (const unsubscribe of subscriptions) unsubscribe();
			closing = (async () => {
				await controller.close();
				await Promise.allSettled([...retiring]);
				listeners.clear();
				chat = null;
				current = null;
			})();
			return closing;
		},
	};
}
