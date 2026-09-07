import { useId } from "react";
import {
	EMPTY_FLEET_FILTER,
	type FleetFacets,
	type FleetFacetValue,
	type FleetFilter,
	type FleetOutcomeFilter,
	isFleetFilterActive,
} from "./fleet-filters.ts";
import type { WireFleetEvidenceState } from "./protocol.ts";

type FacetKey = Exclude<keyof FleetFilter, "query">;

const FACET_GROUPS: ReadonlyArray<{ readonly key: FacetKey; readonly label: string }> = [
	{ key: "outcome", label: "Outcome" },
	{ key: "agent", label: "Agent" },
	{ key: "node", label: "Node" },
	{ key: "lineage", label: "Fleet" },
	{ key: "evidence", label: "Receipt" },
];

function FacetGroup({ label, values, selected, onSelect }: {
	label: string;
	values: readonly FleetFacetValue[];
	selected: string | null;
	onSelect(value: string | null): void;
}) {
	const labelId = useId();
	// A facet with one value cannot narrow anything, and a chip that changes
	// nothing is noise, so the group is absent. A pressed chip stays visible
	// even when a refresh shrinks its facet to one value, so the narrowing the
	// operator applied is never hidden while it is still in force.
	if (values.length < 2 && selected === null) return null;
	return (
		<div className="fleet-filter__group" role="group" aria-labelledby={labelId}>
			<span className="fleet-filter__group-label" id={labelId}>{label}</span>
			<div className="fleet-filter__chips">
				{values.map((facet) => {
					const pressed = selected === facet.value;
					return (
						<button
							type="button"
							className="fleet-filter__chip"
							key={facet.value}
							aria-pressed={pressed}
							onClick={() => onSelect(pressed ? null : facet.value)}
						>
							<span>{facet.label}</span>
							<small aria-label={`${facet.count} ${facet.count === 1 ? "run" : "runs"}`}>{facet.count}</small>
						</button>
					);
				})}
			</div>
		</div>
	);
}

/**
 * A controlled filter over the run window. The bar owns no data: the facets
 * come from the rows on screen and the summary sentence is composed by the
 * caller from the filtered count, so the copy and the list cannot disagree.
 */
export function FleetFilterBar({ filter, facets, summary, onChange }: {
	filter: FleetFilter;
	facets: FleetFacets;
	summary: string;
	onChange(next: FleetFilter): void;
}) {
	const inputId = useId();
	const summaryId = useId();
	const active = isFleetFilterActive(filter);
	// Outcome and receipt values only ever come from the derived facets, whose
	// members are the closed vocabularies these two fields are typed with.
	function setFacet(key: FacetKey, value: string | null): void {
		if (key === "outcome") onChange({ ...filter, outcome: value as FleetOutcomeFilter | null });
		else if (key === "evidence") onChange({ ...filter, evidence: value as WireFleetEvidenceState | null });
		else onChange({ ...filter, [key]: value });
	}
	return (
		<section className="fleet-filter" aria-label="Narrow this window">
			<div className="fleet-filter__query">
				<label htmlFor={inputId}>Narrow this window</label>
				<div>
					<span aria-hidden="true">⌕</span>
					<input
						id={inputId}
						type="search"
						value={filter.query}
						onChange={(event) => onChange({ ...filter, query: event.target.value })}
						placeholder="Run, agent, model, target, node, or task"
						aria-describedby={summaryId}
						autoComplete="off"
					/>
					{filter.query.length > 0 && (
						<button
							type="button"
							onClick={() => onChange({ ...filter, query: "" })}
							aria-label="Clear run search"
						>
							×
						</button>
					)}
				</div>
			</div>
			<div className="fleet-filter__facets">
				{FACET_GROUPS.map((group) => (
					<FacetGroup
						key={group.key}
						label={group.label}
						values={facets[group.key]}
						selected={filter[group.key]}
						onSelect={(value) => setFacet(group.key, value)}
					/>
				))}
			</div>
			<div className="fleet-filter__summary">
				<p id={summaryId} role="status">{summary}</p>
				{active && (
					<button
						type="button"
						className="button button--quiet"
						onClick={() => onChange(EMPTY_FLEET_FILTER)}
					>
						Clear the filter
					</button>
				)}
			</div>
		</section>
	);
}
