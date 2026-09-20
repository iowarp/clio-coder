import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	applyLibraryLifecycle,
	type LibraryLifecyclePlan,
	type LibraryLifecycleRequest,
	planLibraryLifecycle,
	releaseLibraryLifecycle,
} from "../../../../../src/domains/resources/library-actions.js";
import { AppProblem } from "../../services/problem.js";

export type LifecycleRequest = Pick<
	LibraryLifecycleRequest,
	"operation" | "ref" | "scope" | "force" | "withRequirements"
>;
const TTL_MS = 10 * 60_000;
const MAX_PLANS = 8;
const clip = (text: string) => (text.length > 600 ? `${text.slice(0, 599)}…` : text);
const message = (error: unknown) => clip(error instanceof Error ? error.message : String(error));

/**
 * Staged plans live in the single ops lane between review and apply, so the plan the operator read
 * is the plan that commits. An abandoned review is released by its timer; a lost worker loses only
 * staged temp sources, and apply then answers not_found so the page plans again.
 */
export function libraryLifecycleAdapter(ttlMs = TTL_MS) {
	const held = new Map<string, { plan: LibraryLifecyclePlan; timer: NodeJS.Timeout }>();
	const drop = (id: string) => {
		const entry = held.get(id);
		if (!entry) return false;
		clearTimeout(entry.timer);
		held.delete(id);
		releaseLibraryLifecycle(entry.plan);
		return true;
	};
	const take = (cwd: string, id: string) => {
		const entry = held.get(id);
		if (!entry || entry.plan.cwd !== cwd)
			throw new AppProblem("not_found", "This plan expired or was already applied. Review the change again.");
		return entry.plan;
	};
	return {
		plan(cwd: string, request: LifecycleRequest) {
			// Root resolution tries a local path before the catalog; the browser may only name catalog rows.
			if (existsSync(resolve(cwd, request.ref)))
				throw new AppProblem("validation", "A local path shadows this package reference. Install it from a terminal.");
			let plan: LibraryLifecyclePlan;
			try {
				plan = planLibraryLifecycle({ ...request, cwd });
			} catch (error) {
				const detail = message(error);
				throw new AppProblem(/not installed|neither an existing/i.test(detail) ? "not_found" : "operation_failed", detail);
			}
			while (held.size >= MAX_PLANS) drop(held.keys().next().value as string);
			const timer = setTimeout(() => drop(plan.id), ttlMs);
			timer.unref();
			held.set(plan.id, { plan, timer });
			return {
				id: plan.id,
				createdAt: plan.createdAt,
				expiresAt: new Date(Date.parse(plan.createdAt) + ttlMs).toISOString(),
				operation: plan.request.operation,
				applicable: plan.applicable,
				// `expected` is the writer's recheck ledger, not something an operator reviews.
				steps: plan.steps.map(({ expected: _expected, ...step }) => step),
				diagnostics: plan.diagnostics.map(clip),
			};
		},
		apply(cwd: string, id: string) {
			const plan = take(cwd, id);
			clearTimeout(held.get(id)?.timer);
			held.delete(id);
			// applyLibraryLifecycle releases the staged sources itself, on every path.
			const result = applyLibraryLifecycle(plan);
			return {
				planId: result.planId,
				committed: result.committed,
				failed: result.failed,
				unattempted: result.unattempted,
				outcomes: result.outcomes.map((outcome) => ({
					...outcome,
					...(outcome.error
						? { error: { code: outcome.error.code, message: clip(outcome.error.message), next: outcome.error.next } }
						: {}),
				})),
				refresh: {
					status: "not-applicable" as const,
					reason: "The web server holds no agent session; an open conversation keeps its library until it reloads.",
				},
			};
		},
		release(cwd: string, id: string) {
			const entry = held.get(id);
			return { released: !!entry && entry.plan.cwd === cwd && drop(id) };
		},
	};
}
