/**
 * Ordered, copy-on-write registration table behind a middleware contract.
 *
 * Three tiers share one id namespace and one evaluation list:
 *
 *   - fixed: declarative rules (builtin plus composition-root definitions),
 *     immutable for the life of the contract and always evaluated first;
 *   - host: coded registrations appended by the composition root through
 *     registerHook, append-only, first id wins;
 *   - owned: registration sets replaced as one unit by an owner under a
 *     strictly increasing generation. Today the only owner is "user-hooks".
 *
 * The evaluation list is a frozen array replaced by reference. Every writer
 * runs to completion on one stack, so a reader that captures the list at
 * entry evaluates one consistent set even across an await, and a prepared
 * replacement publishes with a single assignment that cannot throw.
 */

import type { MiddlewareDiagnostic, MiddlewareDiagnosticSink, MiddlewareHookRegistration } from "./runtime.js";

export const MIDDLEWARE_REGISTRATION_OWNERS = ["user-hooks"] as const;

export type MiddlewareRegistrationOwner = (typeof MIDDLEWARE_REGISTRATION_OWNERS)[number];

export type MiddlewareRegistrationConflictTier = "builtin" | "host" | "owned";

export interface MiddlewareRegistrationConflict {
	id: string;
	conflictsWith: MiddlewareRegistrationConflictTier;
}

export type ReplaceRegistrationsRejection = "stale" | "unknown-owner";

export interface ReplaceRegistrationsReport {
	applied: boolean;
	owner: MiddlewareRegistrationOwner;
	/** Generation active for the owner after the call. */
	activeGeneration: number;
	reason?: ReplaceRegistrationsRejection;
	/** Offered registrations dropped for colliding with a builtin, host, or earlier owned id. */
	dropped: ReadonlyArray<MiddlewareRegistrationConflict>;
	/**
	 * Remove this generation's registrations if the owner still holds it. A
	 * disposer for a superseded generation is a no-op, so a late disposal can
	 * never remove a newer generation's registrations.
	 */
	dispose(): void;
}

/**
 * A validated replacement whose evaluation list is already built. `commit`
 * assigns that list and is the only visible step; it refuses (applied: false)
 * when a newer generation or a host registration landed after `prepare`.
 */
export interface MiddlewareRegistrationReplacement {
	owner: MiddlewareRegistrationOwner;
	generation: number;
	dropped: ReadonlyArray<MiddlewareRegistrationConflict>;
	/** Registrations that will be active for the owner after commit. */
	size: number;
	/** True while commit would apply: no newer generation, no host change since prepare. */
	current(): boolean;
	commit(): ReplaceRegistrationsReport;
	discard(): void;
}

export type PrepareRegistrationReplacementResult =
	| { status: "prepared"; replacement: MiddlewareRegistrationReplacement }
	| {
			status: "rejected";
			owner: MiddlewareRegistrationOwner;
			reason: ReplaceRegistrationsRejection;
			activeGeneration: number;
	  };

export interface MiddlewareRegistrationTable {
	/** The current frozen evaluation list. Capture once per evaluation. */
	list(): ReadonlyArray<MiddlewareHookRegistration>;
	registerHook(registration: MiddlewareHookRegistration): void;
	prepareReplacement(
		owner: MiddlewareRegistrationOwner,
		generation: number,
		registrations: ReadonlyArray<MiddlewareHookRegistration>,
	): PrepareRegistrationReplacementResult;
	replaceRegistrations(
		owner: MiddlewareRegistrationOwner,
		generation: number,
		registrations: ReadonlyArray<MiddlewareHookRegistration>,
	): ReplaceRegistrationsReport;
	ownedGeneration(owner: MiddlewareRegistrationOwner): number;
}

interface OwnerSlot {
	generation: number;
	registrations: ReadonlyArray<MiddlewareHookRegistration>;
	/** Host index the slot sits before; fixed at the owner's first replacement. */
	anchor: number;
}

export interface MiddlewareRegistrationTableOptions {
	fixed: ReadonlyArray<MiddlewareHookRegistration>;
	/** Resolved per emission so the composition root can swap the sink later. */
	diagnosticSink: () => MiddlewareDiagnosticSink;
}

function isRegistrationOwner(value: string): value is MiddlewareRegistrationOwner {
	return (MIDDLEWARE_REGISTRATION_OWNERS as ReadonlyArray<string>).includes(value);
}

export function createMiddlewareRegistrationTable(
	options: MiddlewareRegistrationTableOptions,
): MiddlewareRegistrationTable {
	const fixed = Object.freeze([...options.fixed]);
	const fixedIds = new Set(fixed.map((registration) => registration.id));
	const host: MiddlewareHookRegistration[] = [];
	const hostIds = new Set<string>();
	const slots = new Map<MiddlewareRegistrationOwner, OwnerSlot>();
	// Bumped on every host append; a prepared replacement built against an
	// older host set refuses to commit rather than publish a list that omits it.
	let hostVersion = 0;
	let evaluationList: ReadonlyArray<MiddlewareHookRegistration> = fixed;

	const emit = (diagnostic: MiddlewareDiagnostic): void => {
		try {
			options.diagnosticSink()(diagnostic);
		} catch {
			// A diagnostics sink must never affect registration bookkeeping.
		}
	};

	const buildList = (
		overrides: ReadonlyMap<MiddlewareRegistrationOwner, OwnerSlot>,
	): ReadonlyArray<MiddlewareHookRegistration> => {
		const list: MiddlewareHookRegistration[] = [...fixed];
		const slotAt = (index: number): void => {
			for (const owner of MIDDLEWARE_REGISTRATION_OWNERS) {
				const slot = overrides.get(owner) ?? slots.get(owner);
				if (slot !== undefined && slot.anchor === index) list.push(...slot.registrations);
			}
		};
		for (let index = 0; index < host.length; index += 1) {
			slotAt(index);
			list.push(host[index] as MiddlewareHookRegistration);
		}
		slotAt(host.length);
		return Object.freeze(list);
	};

	const rebuild = (): void => {
		evaluationList = buildList(new Map());
	};

	const slotFor = (owner: MiddlewareRegistrationOwner): OwnerSlot =>
		slots.get(owner) ?? { generation: 0, registrations: [], anchor: host.length };

	const table: MiddlewareRegistrationTable = {
		list: () => evaluationList,
		registerHook(registration) {
			if (fixedIds.has(registration.id) || hostIds.has(registration.id)) return;
			for (const [owner, slot] of slots) {
				if (!slot.registrations.some((entry) => entry.id === registration.id)) continue;
				slots.set(owner, {
					...slot,
					registrations: Object.freeze(slot.registrations.filter((entry) => entry.id !== registration.id)),
				});
				emit({
					kind: "registration_conflict",
					registrationId: registration.id,
					owner,
					generation: slot.generation,
					conflictsWith: "host",
					action: "evicted",
				});
			}
			host.push(registration);
			hostIds.add(registration.id);
			hostVersion += 1;
			rebuild();
		},
		prepareReplacement(owner, generation, registrations) {
			if (!isRegistrationOwner(owner)) {
				return { status: "rejected", owner, reason: "unknown-owner", activeGeneration: 0 };
			}
			const slot = slotFor(owner);
			if (!Number.isInteger(generation) || generation <= slot.generation) {
				return { status: "rejected", owner, reason: "stale", activeGeneration: slot.generation };
			}
			const dropped: MiddlewareRegistrationConflict[] = [];
			const accepted: MiddlewareHookRegistration[] = [];
			const seen = new Set<string>();
			for (const registration of registrations) {
				const conflictsWith: MiddlewareRegistrationConflictTier | null = fixedIds.has(registration.id)
					? "builtin"
					: hostIds.has(registration.id)
						? "host"
						: seen.has(registration.id)
							? "owned"
							: null;
				if (conflictsWith !== null) {
					dropped.push({ id: registration.id, conflictsWith });
					emit({
						kind: "registration_conflict",
						registrationId: registration.id,
						owner,
						generation,
						conflictsWith,
						action: "dropped",
					});
					continue;
				}
				seen.add(registration.id);
				accepted.push(registration);
			}
			const nextSlot: OwnerSlot = { generation, registrations: Object.freeze(accepted), anchor: slot.anchor };
			const nextList = buildList(new Map([[owner, nextSlot]]));
			const preparedHostVersion = hostVersion;
			let settled = false;
			const current = (): boolean =>
				!settled && hostVersion === preparedHostVersion && generation > slotFor(owner).generation;
			const frozenDropped = Object.freeze(dropped);
			const replacement: MiddlewareRegistrationReplacement = {
				owner,
				generation,
				dropped: frozenDropped,
				size: accepted.length,
				current,
				commit() {
					if (!current()) {
						settled = true;
						return {
							applied: false,
							owner,
							activeGeneration: slotFor(owner).generation,
							reason: "stale",
							dropped: frozenDropped,
							dispose: () => undefined,
						};
					}
					settled = true;
					slots.set(owner, nextSlot);
					// The one visible step: a reference assignment with nothing
					// after it that can throw or yield.
					evaluationList = nextList;
					return {
						applied: true,
						owner,
						activeGeneration: generation,
						dropped: frozenDropped,
						dispose: () => {
							const held = slots.get(owner);
							if (held === undefined || held.generation !== generation || held.registrations.length === 0) return;
							slots.set(owner, { ...held, registrations: Object.freeze([]) });
							rebuild();
						},
					};
				},
				discard() {
					settled = true;
				},
			};
			return { status: "prepared", replacement };
		},
		replaceRegistrations(owner, generation, registrations) {
			const prepared = table.prepareReplacement(owner, generation, registrations);
			if (prepared.status === "rejected") {
				return {
					applied: false,
					owner: prepared.owner,
					activeGeneration: prepared.activeGeneration,
					reason: prepared.reason,
					dropped: [],
					dispose: () => undefined,
				};
			}
			return prepared.replacement.commit();
		},
		ownedGeneration(owner) {
			return slots.get(owner)?.generation ?? 0;
		},
	};
	return table;
}
