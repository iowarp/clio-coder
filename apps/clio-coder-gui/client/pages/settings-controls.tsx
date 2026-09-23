import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { SettingControl, SettingsControls, SettingWritten } from "../../contracts/settings-controls.js";
import { ApiProblem, type Client, emptyInput } from "../api/client.js";
import {
	emptyMeaning,
	groupControls,
	matchesControl,
	selectOptions,
	sentence,
	sourceLabel,
	TIMING_LABEL,
	TIMING_SENTENCE,
	writtenSentences,
} from "./settings-control-model.js";
import "./settings-controls.css";

function ControlRow({
	control,
	save,
	workspaceId,
	draft,
	onDraft,
}: {
	control: SettingControl;
	save: (write: { path: string; value: string; confirmed?: boolean }) => Promise<SettingWritten>;
	workspaceId: string;
	draft: string | null;
	onDraft: (value: string | null) => void;
}) {
	const fieldId = useId(),
		helpId = useId();
	const submitting = useRef(false);
	const [confirmed, setConfirmed] = useState(false),
		[saved, setSaved] = useState<{ sentences: string[]; timing: SettingWritten["timing"] } | null>(null);
	const write = useMutation({
		scope: { id: `settings-write:${workspaceId}` },
		mutationFn: save,
		onSuccess: (result) => {
			setSaved({
				sentences: writtenSentences(result.changed, result.controls.controls, control.path),
				timing: result.timing,
			});
			onDraft(null);
			setConfirmed(false);
		},
		onSettled: () => {
			submitting.current = false;
		},
	});
	const value = draft ?? control.value;
	const dirty = draft !== null && draft !== control.value;
	const options = selectOptions(control);
	const edit = (next: string) => {
		onDraft(next === control.value ? null : next);
		setSaved(null);
		write.reset();
	};
	const writable = control.access === "writable";
	return (
		<div className="setting-control" data-access={control.access}>
			<div className="setting-control__about">
				<label htmlFor={writable ? fieldId : undefined}>{control.label}</label>
				<p id={helpId}>{control.description}</p>
				{control.help && <p className="setting-control__help">{control.help}</p>}
				{control.note && <p className="setting-control__note">{control.note}</p>}
				<small>
					<code>{control.path}</code> · {sourceLabel(control.source)} · {TIMING_LABEL[control.timing]}
				</small>
			</div>
			<div className="setting-control__edit">
				{!writable ? (
					<>
						<output>{control.value || emptyMeaning(control)}</output>
						<p className="setting-control__reason">{control.reason}</p>
					</>
				) : (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							if (dirty && !submitting.current) {
								submitting.current = true;
								write.mutate({ path: control.path, value, ...(control.confirm ? { confirmed } : {}) });
							}
						}}
					>
						{options ? (
							<select
								id={fieldId}
								aria-describedby={helpId}
								value={value}
								disabled={write.isPending}
								onChange={(event) => edit(event.target.value)}
							>
								{options.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						) : (
							<input
								id={fieldId}
								aria-describedby={helpId}
								type={control.kind === "number" ? "number" : "text"}
								disabled={write.isPending}
								step={control.kind === "number" ? "any" : undefined}
								value={value}
								placeholder={emptyMeaning(control)}
								list={control.suggestions ? `${fieldId}-suggestions` : undefined}
								onChange={(event) => edit(event.target.value)}
							/>
						)}
						{control.suggestions && !options && (
							<datalist id={`${fieldId}-suggestions`}>
								{control.suggestions.map((suggestion) => (
									<option key={suggestion} value={suggestion} />
								))}
							</datalist>
						)}
						{control.valueHelp[value] && <p className="setting-control__help">{sentence(control.valueHelp[value])}</p>}
						{control.kind === "list" && <small>Separate values with commas.</small>}
						{dirty && control.confirm && (
							<label className="setting-control__confirm">
								<input
									type="checkbox"
									checked={confirmed}
									disabled={write.isPending}
									onChange={(event) => setConfirmed(event.target.checked)}
								/>
								<span>{control.confirm} I understand.</span>
							</label>
						)}
						{dirty && (
							<div className="setting-control__actions">
								<button type="submit" className="primary" disabled={write.isPending || (!!control.confirm && !confirmed)}>
									{write.isPaused ? "Waiting…" : write.isPending ? "Saving…" : "Save"}
								</button>
								<button type="button" disabled={write.isPending} onClick={() => edit(control.value)}>
									Revert
								</button>
							</div>
						)}
						{write.error && (
							<p className="setting-control__error" role="alert">
								{write.error.message}
								{write.error instanceof ApiProblem && write.error.problem.code === "conflict"
									? " A project file sets this value."
									: ""}
							</p>
						)}
						{saved && (
							<p className="setting-control__saved" role="status">
								{saved.sentences.join(" ")} {TIMING_SENTENCE[saved.timing]}
							</p>
						)}
					</form>
				)}
			</div>
		</div>
	);
}

export function SettingsControlsView({ client, workspaceId }: { client: Client; workspaceId: string }) {
	const queries = useQueryClient();
	const [section, setSection] = useState<string | null>(null),
		[filter, setFilter] = useState(""),
		[showDrafts, setShowDrafts] = useState(false),
		[drafts, setDrafts] = useState<Record<string, string>>({});
	const key = ["settings-controls", workspaceId];
	const report = useQuery({
		queryKey: key,
		queryFn: () => client.call(routes.settingsControls, { ...emptyInput, params: { id: workspaceId } }),
	});
	useEffect(() => {
		if (!report.data) return;
		setDrafts((current) => {
			const next = { ...current };
			let changed = false;
			for (const control of report.data.controls) {
				if (next[control.path] !== control.value) continue;
				delete next[control.path];
				changed = true;
			}
			return changed ? next : current;
		});
	}, [report.data]);
	const updateDraft = (path: string, value: string | null) => {
		setDrafts((current) => {
			const next = { ...current };
			if (value === null) delete next[path];
			else next[path] = value;
			return next;
		});
	};
	if (report.isPending) return <p>Reading settings…</p>;
	if (!report.data)
		return (
			<div role="alert">
				<p>{report.error?.message ?? "Settings are unavailable."}</p>
				<button type="button" disabled={report.isFetching} onClick={() => void report.refetch()}>
					{report.isFetching ? "Trying again…" : "Try again"}
				</button>
			</div>
		);
	const save = async (body: { path: string; value: string; confirmed?: boolean }) => {
		const result = await client.call(routes.writeSetting, { params: { id: workspaceId }, query: {}, body });
		queries.setQueryData<SettingsControls>(key, result.controls);
		for (const stale of ["workspace-settings", "config-graph", "targets", "routing"])
			void queries.invalidateQueries({ queryKey: [stale] });
		return result;
	};
	const { sections, controls, userFile } = report.data;
	const unsaved = controls.filter(
		(control) => drafts[control.path] !== undefined && drafts[control.path] !== control.value,
	);
	const active = showDrafts || filter.trim() ? null : (section ?? sections[0]?.id ?? null);
	const visible = showDrafts
		? unsaved
		: controls.filter((control) => (active ? control.section === active : matchesControl(control, filter)));
	const current = sections.find((candidate) => candidate.id === active);
	return (
		<>
			{report.error ? (
				<div className="settings-refresh" role="alert">
					<span>Could not refresh settings: {report.error.message} Showing the last received values.</span>
					<button type="button" disabled={report.isFetching} onClick={() => void report.refetch()}>
						{report.isFetching ? "Refreshing…" : "Retry refresh"}
					</button>
				</div>
			) : null}
			<p>
				These user settings can affect other projects. The selected project determines which effective values and sources
				are shown. Changes are checked against the whole configuration and saved to your user settings
				{userFile && (
					<>
						{" "}
						at <code className="inline-path">{userFile}</code>
					</>
				)}
				. Project files are never written from here.
			</p>
			<label className="settings-filter">
				Find a setting
				<input
					type="search"
					value={filter}
					onChange={(event) => {
						setFilter(event.target.value);
						setShowDrafts(false);
					}}
				/>
			</label>
			<nav className="settings-tabs" aria-label="Settings sections">
				{sections.map((candidate) => (
					<button
						type="button"
						key={candidate.id}
						aria-pressed={active === candidate.id}
						onClick={() => {
							setSection(candidate.id);
							setFilter("");
							setShowDrafts(false);
						}}
					>
						{candidate.label} · {controls.filter((control) => control.section === candidate.id).length}
					</button>
				))}
				{unsaved.length > 0 || showDrafts ? (
					<button
						type="button"
						aria-pressed={showDrafts}
						onClick={() => {
							setFilter("");
							setShowDrafts(true);
						}}
					>
						Unsaved · {unsaved.length}
					</button>
				) : null}
			</nav>
			<h2>
				{showDrafts ? `Unsaved changes · ${visible.length}` : current ? current.label : `Matches · ${visible.length}`}
			</h2>
			{current && <p>{current.description}</p>}
			{!visible.length && <p>{showDrafts ? "No unsaved changes." : "No settings match."}</p>}
			{groupControls(visible).map(({ group, controls: rows }) => (
				<section key={group} className="setting-group" aria-label={group}>
					<h3>{group}</h3>
					{rows.map((control) => (
						<ControlRow
							key={control.path}
							control={control}
							save={save}
							workspaceId={workspaceId}
							draft={drafts[control.path] ?? null}
							onDraft={(value) => updateDraft(control.path, value)}
						/>
					))}
				</section>
			))}
		</>
	);
}
