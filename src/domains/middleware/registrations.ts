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
 * The whole table is one immutable state object held behind a single
 * reference. Every writer computes a complete next state and publishes it
 * with one assignment; readers capture the reference once per evaluation, so
 * an evaluation that started before a publish finishes against the state it
 * started with, including across an await. Preparation never runs user code:
 * conflicts are returned as frozen data and a caller emits them through the
 * diagnostic sink only after publication.
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

export type RegistrationConflictDiagnostic = Extract<MiddlewareDiagnostic, { kind: "registration_conflict" }>;

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
 * A validated replacement whose complete next table state is already built.
 * `publish` is one reference assignment: it does not validate, refuse,
 * throw, or call out. The caller checks `current()` on the same stack
 * immediately before publishing, then emits `conflicts` afterwards.
 */
export interface MiddlewareRegistrationReplacement {
	owner: MiddlewareRegistrationOwner;
	generation: number;
	dropped: ReadonlyArray<MiddlewareRegistrationConflict>;
	/** Diagnostics for `dropped`, as data. Nothing was emitted during preparation. */
	conflicts: ReadonlyArray<RegistrationConflictDiagnostic>;
	/** Registrations that will be active for the owner after publish. */
	size: number;
	/** True while the table state this replacement was prepared against is still the live one. */
	current(): boolean;
	/** Assignment-only publication of the prepared state. */
	publish(): void;
	/** Send `conflicts` to the diagnostic sink. Call only after publication. */
	emitConflicts(): void;
	/** Remove this generation's registrations if the owner still holds it. */
	dispose(): void;
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

/** One immutable table state. Replaced wholesale, never mutated. */
interface TableState {
	host: ReadonlyArray<MiddlewareHookRegistration>;
	hostIds: ReadonlySet<string>;
	slots: ReadonlyMap<MiddlewareRegistrationOwner, OwnerSlot>;
	list: ReadonlyArray<MiddlewareHookRegistration>;
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

	const buildList = (
		host: ReadonlyArray<MiddlewareHookRegistration>,
		slots: ReadonlyMap<MiddlewareRegistrationOwner, OwnerSlot>,
	): ReadonlyArray<MiddlewareHookRegistration> => {
		const list: MiddlewareHookRegistration[] = [...fixed];
		const slotAt = (index: number): void => {
			for (const owner of MIDDLEWARE_REGISTRATION_OWNERS) {
				const slot = slots.get(owner);
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

	const makeState = (
		host: ReadonlyArray<MiddlewareHookRegistration>,
		slots: ReadonlyMap<MiddlewareRegistrationOwner, OwnerSlot>,
	): TableState =>
		Object.freeze({
			host: Object.freeze([...host]),
			hostIds: new Set(host.map((registration) => registration.id)),
			slots: new Map(slots),
			list: buildList(host, slots),
		});

	// The single live reference. Every publish below is `state = next`.
	let state: TableState = makeState([], new Map());

	const emit = (diagnostic: MiddlewareDiagnostic): void => {
		try {
			options.diagnosticSink()(diagnostic);
		} catch {
			// A diagnostics sink must never affect registration bookkeeping.
		}
	};

	const slotFor = (base: TableState, owner: MiddlewareRegistrationOwner): OwnerSlot =>
		base.slots.get(owner) ?? { generation: 0, registrations: [], anchor: base.host.length };

	const disposeGeneration = (owner: MiddlewareRegistrationOwner, generation: number): void => {
		const base = state;
		const held = base.slots.get(owner);
		if (held === undefined || held.generation !== generation || held.registrations.length === 0) return;
		const slots = new Map(base.slots);
		slots.set(owner, { ...held, registrations: Object.freeze([]) });
		state = makeState(base.host, slots);
	};

	const table: MiddlewareRegistrationTable = {
		list: () => state.list,
		registerHook(registration) {
			const base = state;
			if (fixedIds.has(registration.id) || base.hostIds.has(registration.id)) return;
			const evictions: RegistrationConflictDiagnostic[] = [];
			const slots = new Map(base.slots);
			for (const [owner, slot] of base.slots) {
				if (!slot.registrations.some((entry) => entry.id === registration.id)) continue;
				slots.set(owner, {
					...slot,
					registrations: Object.freeze(slot.registrations.filter((entry) => entry.id !== registration.id)),
				});
				evictions.push({
					kind: "registration_conflict",
					registrationId: registration.id,
					owner,
					generation: slot.generation,
					conflictsWith: "host",
					action: "evicted",
				});
			}
			state = makeState([...base.host, registration], slots);
			// Diagnostics only after the publish; a sink that registers another
			// host hook re-enters against the already-published state.
			for (const eviction of evictions) emit(eviction);
		},
		prepareReplacement(owner, generation, registrations) {
			if (!isRegistrationOwner(owner)) {
				return { status: "rejected", owner, reason: "unknown-owner", activeGeneration: 0 };
			}
			const base = state;
			const slot = slotFor(base, owner);
			if (!Number.isInteger(generation) || generation <= slot.generation) {
				return { status: "rejected", owner, reason: "stale", activeGeneration: slot.generation };
			}
			const dropped: MiddlewareRegistrationConflict[] = [];
			const conflicts: RegistrationConflictDiagnostic[] = [];
			const accepted: MiddlewareHookRegistration[] = [];
			const seen = new Set<string>();
			for (const registration of registrations) {
				const conflictsWith: MiddlewareRegistrationConflictTier | null = fixedIds.has(registration.id)
					? "builtin"
					: base.hostIds.has(registration.id)
						? "host"
						: seen.has(registration.id)
							? "owned"
							: null;
				if (conflictsWith !== null) {
					dropped.push({ id: registration.id, conflictsWith });
					conflicts.push({
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
			const slots = new Map(base.slots);
			slots.set(owner, { generation, registrations: Object.freeze(accepted), anchor: slot.anchor });
			const prepared = makeState(base.host, slots);
			let settled = false;
			const frozenDropped = Object.freeze(dropped);
			const frozenConflicts = Object.freeze(conflicts);
			const replacement: MiddlewareRegistrationReplacement = {
				owner,
				generation,
				dropped: frozenDropped,
				conflicts: frozenConflicts,
				size: accepted.length,
				// Reference identity on the base state covers every kind of
				// intervening change: host appends, other replacements, disposals.
				current: () => !settled && state === base,
				publish() {
					settled = true;
					state = prepared;
				},
				emitConflicts() {
					for (const conflict of frozenConflicts) emit(conflict);
				},
				dispose() {
					disposeGeneration(owner, generation);
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
			const replacement = prepared.replacement;
			// Nothing ran between prepare and here, so current() holds; the
			// check is kept so the one-call form has the same shape as a caller
			// that validates on its own stack.
			if (!replacement.current()) {
				replacement.discard();
				return {
					applied: false,
					owner,
					activeGeneration: table.ownedGeneration(owner),
					reason: "stale",
					dropped: replacement.dropped,
					dispose: () => undefined,
				};
			}
			replacement.publish();
			replacement.emitConflicts();
			return {
				applied: true,
				owner,
				activeGeneration: generation,
				dropped: replacement.dropped,
				dispose: () => replacement.dispose(),
			};
		},
		ownedGeneration(owner) {
			return state.slots.get(owner)?.generation ?? 0;
		},
	};
	return table;
}
