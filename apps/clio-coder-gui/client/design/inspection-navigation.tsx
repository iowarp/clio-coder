import { type ReactNode, useEffect, useRef } from "react";
import { Link, NavLink } from "react-router";
import { ApiProblem } from "../api/client.js";
import type { AreaNavigationProps } from "./area-navigation-props.js";
import { StatusMark, type StatusTone } from "./status.js";
import "./inspection-navigation.css";

export interface InspectionRow {
	id: string;
	title: string;
	detail: string;
	href: string;
	status: string;
	tone: StatusTone;
}

export type InspectionNavigationProps = AreaNavigationProps;

export function referenceRefused(error: unknown): boolean {
	return error instanceof ApiProblem && error.problem.status === 403;
}

export function InspectionSelection({
	title,
	row,
	live = true,
	viewerLabel,
	dismiss,
	close,
	children,
	recover,
	recovering = false,
}: {
	title: string;
	row: InspectionRow | undefined;
	live?: boolean;
	viewerLabel: string;
	dismiss: () => void;
	close?: (() => void) | undefined;
	children: ReactNode;
	recover?: (() => void) | undefined;
	recovering?: boolean;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		if (row?.id) heading.current?.focus();
	}, [row?.id]);
	return (
		<section className="inspection-navigation__selection" aria-label={title}>
			<button
				type="button"
				onClick={() => {
					const scope = heading.current?.closest(".inspection-navigation");
					const origin = Array.from(scope?.querySelectorAll<HTMLButtonElement>("button[data-record-id]") ?? []).find(
						(button) => button.dataset.recordId === row?.id,
					);
					dismiss();
					requestAnimationFrame(() => origin?.focus());
				}}
			>
				← Back to records
			</button>
			<h3 ref={heading} tabIndex={-1}>
				{row?.title ?? title}
			</h3>
			{children}
			{row && live ? (
				<Link to={row.href} onClick={close}>
					{viewerLabel}
				</Link>
			) : (
				<p>
					Refresh history and select the record again to open its viewer.
					{recover ? (
						<button type="button" disabled={recovering} onClick={recover}>
							Refresh history
						</button>
					) : null}
				</p>
			)}
		</section>
	);
}

export function InspectionNavigation({ scope, children }: { scope: string; children: ReactNode }) {
	return (
		<section className="inspection-navigation" aria-label="Recorded history navigation">
			<p className="inspection-navigation__scope">{scope}</p>
			{children}
		</section>
	);
}

export function InspectionRecords({
	title,
	rows,
	query,
	live = true,
	absent = false,
	unavailable = false,
	close,
	onSelect,
	selectedId,
}: {
	title: string;
	rows: InspectionRow[];
	query: {
		isPending: boolean;
		isFetching: boolean;
		isFetchingNextPage: boolean;
		isRefetching: boolean;
		isRefetchError: boolean;
		error: Error | null;
		hasNextPage: boolean;
		refetch: () => unknown;
		fetchNextPage: () => unknown;
	};
	live?: boolean;
	absent?: boolean;
	unavailable?: boolean;
	close?: (() => void) | undefined;
	onSelect?: ((row: InspectionRow) => void) | undefined;
	selectedId?: string | undefined;
}) {
	return (
		<section className="inspection-navigation__records" aria-label={title}>
			<div className="inspection-navigation__heading">
				<h3>{title}</h3>
				<button
					type="button"
					disabled={query.isFetching || unavailable}
					onClick={() => void query.refetch()}
					aria-label={`Refresh ${title.toLowerCase()}`}
				>
					Refresh
				</button>
			</div>
			{unavailable ? (
				<p className="inspection-navigation__note">No trace database available.</p>
			) : query.isPending ? (
				<p className="inspection-navigation__note" role="status">
					Loading records…
				</p>
			) : null}
			{query.error ? (
				<p className="inspection-navigation__note" role="alert">
					{query.error.message}{" "}
					<button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
						Retry
					</button>
				</p>
			) : null}
			{query.isRefetching ? (
				<p className="inspection-navigation__note" role="status">
					Refreshing history. Links return when the read finishes.
				</p>
			) : null}
			{!unavailable && !query.isPending && !query.error && !rows.length ? (
				<p className="inspection-navigation__note">
					{absent ? "No recorded store is available yet." : "No loaded records match."}
				</p>
			) : null}
			{rows.map((row) => {
				const contents = (
					<>
						<strong>{row.title}</strong>
						<span>{row.detail}</span>
						<StatusMark tone={row.tone} label={row.status} />
					</>
				);
				return live && onSelect ? (
					<button
						type="button"
						key={row.id}
						onClick={() => onSelect(row)}
						className="inspection-navigation__record"
						data-record-id={row.id}
						aria-current={row.id === selectedId ? "true" : undefined}
						title={`${row.title} · ${row.id}`}
					>
						{contents}
					</button>
				) : live ? (
					<NavLink
						key={row.id}
						to={row.href}
						onClick={close}
						className="inspection-navigation__record"
						title={`${row.title} · ${row.id}`}
					>
						{contents}
					</NavLink>
				) : (
					<div key={row.id} className="inspection-navigation__record" aria-disabled="true">
						{contents}
					</div>
				);
			})}
			{!unavailable && query.hasNextPage && !query.isRefetchError ? (
				<button
					className="inspection-navigation__more"
					type="button"
					disabled={query.isFetching}
					onClick={() => void query.fetchNextPage()}
				>
					{query.isFetchingNextPage ? "Loading older records…" : "Load older records"}
				</button>
			) : null}
		</section>
	);
}
