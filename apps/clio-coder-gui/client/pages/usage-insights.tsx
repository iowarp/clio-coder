import { useEffect, useRef, useState } from "react";
import type { UsageReport } from "../../contracts/reports.js";
import type { Client } from "../api/client.js";
import { Facts } from "../design/facts.js";
import { Icon } from "../design/icons.js";
import { Explained } from "../telemetry/Explained.js";
import { countText } from "../telemetry/quantity-model.js";
import type { UsageMetric } from "./usage-insights-model.js";
import {
	attributedCalls,
	compareUsageModels,
	filterUsageModels,
	USAGE_METRICS,
	usageAmountText,
	usageCallShares,
	usageModelInsights,
} from "./usage-insights-model.js";

export function UsageInsights({ client, report }: { client: Client; report: UsageReport }) {
	const [metric, setMetric] = useState<UsageMetric>("calls");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [coverage, setCoverage] = useState("");
	const inspector = useRef<HTMLHeadingElement>(null);
	const opener = useRef<HTMLButtonElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const models = usageModelInsights(report);
	const matching = filterUsageModels(models, query, coverage);
	const rows = compareUsageModels(matching, metric);
	const selected = models.find((row) => row.id === selectedId);
	const shares = usageCallShares(models, attributedCalls(report));
	const activeMetric = USAGE_METRICS.find((item) => item.id === metric);
	const missing = rows.filter((row) => row[metric].value === null || row[metric].partial).length;
	useEffect(() => {
		if (selectedId) inspector.current?.focus();
	}, [selectedId]);
	const closeInspector = () => {
		setSelectedId(null);
		(opener.current?.isConnected ? opener.current : search.current)?.focus();
	};
	return (
		<div className="usage-analysis">
			<section className="usage-comparison" aria-labelledby="usage-comparison-title">
				<header className="usage-section-heading">
					<div>
						<p className="usage-kicker">01 / Model comparison</p>
						<h2 id="usage-comparison-title">Where the work happens</h2>
					</div>
					<span className="usage-model-count">
						<Icon name="models" /> {models.length} model / target {models.length === 1 ? "pair" : "pairs"}
					</span>
				</header>
				<div className="usage-explore-controls">
					<label>
						Find a model or target
						<input
							ref={search}
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							maxLength={256}
							placeholder="Model or target"
						/>
					</label>
					<label>
						Accounting coverage
						<select value={coverage} onChange={(event) => setCoverage(event.target.value)}>
							<option value="">All accounting</option>
							<option value="incomplete">Incomplete amounts</option>
						</select>
					</label>
					{(query || coverage) && (
						<button
							type="button"
							onClick={() => {
								setQuery("");
								setCoverage("");
							}}
						>
							Reset filters
						</button>
					)}
				</div>
				<fieldset className="usage-metric-selector">
					<legend className="sr-only">Compare models by</legend>
					{USAGE_METRICS.map((item) => (
						<button type="button" key={item.id} aria-pressed={metric === item.id} onClick={() => setMetric(item.id)}>
							{item.label}
						</button>
					))}
				</fieldset>
				<p className="usage-chart-caption" aria-live="polite">
					{activeMetric?.description} {rows.length} of {models.length} recorded model / target pairs shown.
				</p>
				{!rows.length ? (
					<p className="panel-empty">
						{models.length
							? "No model or target matches these filters. Reset the filters to see all recorded pairs."
							: "No model usage was recorded in this window. Choose another workspace to inspect its retained records."}
					</p>
				) : (
					<ol className="usage-model-bars" aria-label={`Models ranked by ${activeMetric?.label.toLowerCase()}`}>
						{rows.map((row, index) => (
							<li key={row.id}>
								<button
									className="usage-model-row"
									type="button"
									aria-pressed={selectedId === row.id}
									{...(selected ? { "aria-controls": "usage-model-accounting" } : {})}
									onClick={(event) => {
										opener.current = event.currentTarget;
										if (selectedId === row.id) closeInspector();
										else setSelectedId(row.id);
									}}
								>
									<span className="usage-model-rank" aria-hidden="true">
										{String(index + 1).padStart(2, "0")}
									</span>
									<span className="usage-model-identity">
										<strong>{row.model}</strong>
										<small>{row.target}</small>
									</span>
									<span className="usage-model-amount">
										<strong>{usageAmountText(row[metric])}</strong>
										<small>{row[metric].label}</small>
									</span>
									<span
										className={`usage-model-track${row[metric].value === null ? " usage-model-track--missing" : ""}`}
										aria-hidden="true"
									>
										<span style={{ width: `${row.width}%` }} />
									</span>
								</button>
							</li>
						))}
					</ol>
				)}
				<p className="usage-chart-footnote">
					Bars use the largest known value as their scale.
					{missing > 0 ? ` ${missing} model / target pairs have incomplete ${activeMetric?.label.toLowerCase()} data.` : ""}{" "}
					Select a row to inspect its accounting. ~ marks estimates; +? marks an incomplete amount.
				</p>
				{selected && (
					<section
						id="usage-model-accounting"
						className="usage-model-inspector"
						aria-label={`Accounting for ${selected.model}`}
					>
						<header>
							<h3 ref={inspector} tabIndex={-1}>
								{selected.model}
							</h3>
							<button type="button" onClick={closeInspector} aria-label="Close model accounting">
								<Icon name="close" />
							</button>
						</header>
						<p>{selected.target}</p>
						<dl className="usage-model-measures">
							{USAGE_METRICS.map((item) => (
								<div key={item.id}>
									<dt>{item.label}</dt>
									<dd>
										<Explained
											client={client}
											label={`${item.label}, ${selected.model}`}
											value={usageAmountText(selected[item.id])}
											ref={selected[item.id].ref}
										/>
										<small>{selected[item.id].label}</small>
									</dd>
								</div>
							))}
						</dl>
						<details>
							<summary>
								Model provenance · {selected.facts.length} source {selected.facts.length === 1 ? "fact" : "facts"}
							</summary>
							{selected.facts.map((fact) => (
								<div className="usage-source-fact" key={JSON.stringify(fact)}>
									<h4>{fact.name}</h4>
									<Facts value={fact.values} />
								</div>
							))}
						</details>
					</section>
				)}
			</section>
			<aside className="usage-call-mix" aria-labelledby="usage-call-mix-title">
				<p className="usage-kicker">02 / Call distribution</p>
				<h2 id="usage-call-mix-title">The model mix</h2>
				{shares ? (
					<>
						<div className="usage-donut-wrap">
							<svg
								className="usage-donut"
								viewBox="0 0 200 200"
								role="img"
								aria-label={`${countText(shares.total)} attributed API calls. Shares by model and target are listed below.`}
							>
								<title>API call shares by model and target</title>
								<circle className="usage-donut-ground" cx="100" cy="100" r="78" />
								{shares.segments.map((segment, index) => (
									<circle
										className={`usage-tone-${index % 5}`}
										key={segment.id}
										cx="100"
										cy="100"
										r="78"
										pathLength="100"
										strokeDasharray={`${segment.share * 100} ${100 - segment.share * 100}`}
										strokeDashoffset={-segment.offset * 100}
									>
										<title>
											{segment.model} · {segment.target}: {segment.calls} calls ({(segment.share * 100).toFixed(1)}%)
										</title>
									</circle>
								))}
							</svg>
							<div className="usage-donut-center" aria-hidden="true">
								<strong>{countText(shares.total)}</strong>
								<span>attributed calls</span>
							</div>
						</div>
						<ul className="usage-share-legend">
							{shares.segments.map((segment, index) => (
								<li key={segment.id}>
									<button
										type="button"
										aria-pressed={selectedId === segment.id}
										{...(selected ? { "aria-controls": "usage-model-accounting" } : {})}
										onClick={(event) => {
											opener.current = event.currentTarget;
											setSelectedId(segment.id);
											inspector.current?.focus();
										}}
									>
										<span className={`usage-share-dot usage-tone-${index % 5}`} aria-hidden="true" />
										<span>
											<strong>{segment.model}</strong>
											<small>
												{segment.target} · {countText(segment.calls)} calls
											</small>
										</span>
										<span>{(segment.share * 100).toFixed(1)}%</span>
									</button>
								</li>
							))}
						</ul>
						<p className="usage-chart-footnote">
							Shares of calls across all recorded model pairs, independent of comparison filters. Each call belongs to one
							target and model; token categories are never used as pie slices.
						</p>
					</>
				) : (
					<p className="panel-empty">
						Call shares need complete, nonzero model call counts. No percentages are inferred from missing counts or worker
						run counts.
					</p>
				)}
				<div className="usage-reading-note">
					<Icon name="evidence" />
					<p>
						Evidence, not an invoice.
						<br />
						<span>These insights describe retained local records. Missing usage and unpriced calls remain visible.</span>
					</p>
				</div>
			</aside>
		</div>
	);
}
