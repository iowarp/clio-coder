export type ResourceScope = "package" | "user" | "project" | "cli";

export interface ResourceSourceInfo {
	path: string;
	scope: ResourceScope;
	source?: string;
}

export interface ResourceCollision {
	name: string;
	winnerPath: string;
	loserPath: string;
	winnerScope: ResourceScope;
	loserScope: ResourceScope;
}

export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: ResourceCollision;
}

export interface ResourceCandidate<T> {
	name: string;
	value: T;
	source: ResourceSourceInfo;
}

export interface CollisionResolution<T> {
	winners: T[];
	diagnostics: ResourceDiagnostic[];
}

const SCOPE_RANK: Record<ResourceScope, number> = {
	package: 0,
	user: 1,
	project: 2,
	cli: 3,
};

function compareCandidates<T>(a: ResourceCandidate<T>, b: ResourceCandidate<T>): number {
	const rankDelta = SCOPE_RANK[a.source.scope] - SCOPE_RANK[b.source.scope];
	if (rankDelta !== 0) return rankDelta;
	return a.source.path.localeCompare(b.source.path);
}

export function resolveResourceCollisions<T>(candidates: ReadonlyArray<ResourceCandidate<T>>): CollisionResolution<T> {
	const byName = new Map<string, ResourceCandidate<T>[]>();
	for (const candidate of candidates) {
		const key = candidate.name.trim();
		if (key.length === 0) continue;
		const list = byName.get(key) ?? [];
		list.push(candidate);
		byName.set(key, list);
	}

	const winners: T[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	for (const [name, entries] of byName.entries()) {
		const sorted = [...entries].sort(compareCandidates);
		const winner = sorted[sorted.length - 1];
		if (!winner) continue;
		winners.push(winner.value);
		for (const loser of sorted.slice(0, -1)) {
			diagnostics.push({
				type: "collision",
				message: `${name} from ${winner.source.scope} overrides ${loser.source.scope}`,
				path: loser.source.path,
				collision: {
					name,
					winnerPath: winner.source.path,
					loserPath: loser.source.path,
					winnerScope: winner.source.scope,
					loserScope: loser.source.scope,
				},
			});
		}
	}

	return { winners, diagnostics };
}
