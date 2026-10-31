import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";
import { type Explainable, explanationView } from "./quantity-model.js";
import "./explain.css";

/**
 * A displayed quantity that opens explain() for its reference (#434 §11.4): what it counts, its coverage and where
 * it came from. A value with no reference is plain text, because nothing would resolve it.
 */
export function Explained({ client, label, value, ref }: Explainable & { client: Client; label: string }) {
	const panel = useRef<HTMLDetailsElement>(null);
	const [open, setOpen] = useState(false);
	useDetailsDismiss(panel, open);
	const explanation = useQuery({
		meta: { errorSurface: "inline" },
		// Under "telemetry", so a live update that moves the number re-reads its explanation too.
		queryKey: ["telemetry", "explain", ref],
		queryFn: () => client.call(routes.telemetryExplain, { params: {}, query: { ref: ref ?? "" }, body: {} }),
		enabled: open && ref !== null,
		retry: false,
	});
	if (ref === null) return <>{value}</>;
	const view = explanation.data ? explanationView(explanation.data) : null;
	return (
		<details className="explain" ref={panel} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary aria-label={`${label}: ${value}. Explain this number.`}>{value}</summary>
			<div className="explain__panel">
				<p className="explain__title">{label}</p>
				{explanation.isPending ? <p className="explain__note">Reading where this number came from…</p> : null}
				{explanation.error ? (
					<p className="explain__note" role="alert">
						{explanation.error.message}
					</p>
				) : null}
				{view ? (
					<dl className="explain__facts">
						<div>
							<dt>Value</dt>
							<dd>{view.value}</dd>
						</div>
						<div>
							<dt>Coverage</dt>
							<dd>{view.coverage}</dd>
						</div>
						<div>
							<dt>Counts</dt>
							<dd className="explain__rule">{view.rule}</dd>
						</div>
						{view.sources.map((source) => (
							<div key={source.label} className="explain__source">
								<dt>{source.label}</dt>
								<dd>
									{/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need focus to scroll a long list of ids. */}
									<ul tabIndex={0} aria-label={`${source.label} that contributed`}>
										{source.ids.map((id) => (
											<li key={id}>{id}</li>
										))}
									</ul>
								</dd>
							</div>
						))}
					</dl>
				) : null}
				{view?.omitted ? <p className="explain__note">{view.omitted}</p> : null}
			</div>
		</details>
	);
}
