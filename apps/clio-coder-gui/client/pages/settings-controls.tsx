import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { SettingControl, SettingsControls, SettingWritten } from "../../contracts/settings-controls.js";
import { ApiProblem, type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { useOperation } from "../api/queries.js";
import { MODEL_TARGET_PATHS } from "./model-options.js";
import { ModelSelect } from "./model-select.js";
import {
	emptyMeaning,
	groupControls,
	matchesControl,
	OPEN_CHOICES,
	type OpenChoice,
	selectOptions,
	sentence,
	sourceLabel,
	TIMING_LABEL,
	TIMING_SENTENCE,
	writtenSentences,
} from "./settings-control-model.js";
import "./settings-controls.css";

/** A model setting's catalog: the paired target's models as Clio Coder last read them, and where from. */
interface ModelCatalog {
	readonly models: readonly string[] | null;
	readonly defaultModel: string | null;
	readonly note: ReactNode;
}

const OTHER = "\u0000other";

/**
 * One of the engine's words, or an exact value. A saved exact value opens as the field, so the page
 * never rewrites it, and the field offers a way back to the words.
 */
function OpenChoiceField({
	id,
	describedBy,
	choice,
	value,
	disabled,
	onChange,
}: {
	id: string;
	describedBy: string;
	choice: OpenChoice;
	value: string;
	disabled: boolean;
	onChange: (value: string) => void;
}) {
	const [typing, setTyping] = useState(value !== "" && !choice.words.includes(value));
	const [asked, setAsked] = useState(false);
	if (!typing)
		return (
			<select
				id={id}
				aria-describedby={describedBy}
				value={value}
				disabled={disabled}
				onChange={(event) => {
					if (event.target.value !== OTHER) onChange(event.target.value);
					else {
						setTyping(true);
						setAsked(true);
					}
				}}
			>
				{choice.words.includes(value) ? null : <option value={value}>{value || "Not set"}</option>}
				{choice.words.map((word) => (
					<option key={word} value={word}>
						{word}
					</option>
				))}
				<option value={OTHER}>{choice.other.label}</option>
			</select>
		);
	return (
		<div className="model-select__typed">
			<input
				id={id}
				aria-describedby={describedBy}
				value={choice.words.includes(value) ? "" : value}
				disabled={disabled}
				spellCheck={false}
				autoComplete="off"
				{...(choice.other.field === "whole-number"
					? { type: "number", min: 1, step: 1, inputMode: "numeric" as const, placeholder: "4" }
					: { type: "text", placeholder: "/absolute/path/to/worktrees" })}
				onChange={(event) => onChange(event.target.value)}
				// biome-ignore lint/a11y/noAutofocus: the operator just asked to type the value; the field is where they type it.
				autoFocus={asked}
			/>
			<button type="button" className="model-select__back" disabled={disabled} onClick={() => setTyping(false)}>
				Choose from the list
			</button>
		</div>
	);
}

function ControlRow({
	control,
	save,
	workspaceId,
	draft,
	onDraft,
	catalog,
}: {
	control: SettingControl;
	save: (write: { path: string; value: string; confirmed?: boolean }) => Promise<SettingWritten>;
	workspaceId: string;
	draft: string | null;
	onDraft: (value: string | null) => void;
	catalog?: ModelCatalog | undefined;
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
						{catalog ? (
							<ModelSelect
								id={fieldId}
								describedBy={helpId}
								value={value}
								models={catalog.models}
								defaultModel={catalog.defaultModel}
								disabled={write.isPending}
								note={catalog.note}
								onChange={edit}
							/>
						) : OPEN_CHOICES[control.path] ? (
							<OpenChoiceField
								id={fieldId}
								describedBy={helpId}
								choice={OPEN_CHOICES[control.path] as OpenChoice}
								value={value}
								disabled={write.isPending}
								onChange={edit}
							/>
						) : options ? (
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
	// Model settings pick from their target's catalog. The inventory is read only when one is on
	// screen, and "Check again" asks that target's endpoint for its current list.
	const modelsVisible = (report.data?.controls ?? []).some((control) => MODEL_TARGET_PATHS[control.path]);
	const inventory = useQuery({
		queryKey: ["targets", workspaceId],
		queryFn: () => client.call(routes.targetsList, { ...emptyInput, params: { id: workspaceId } }),
		enabled: modelsVisible,
	});
	const [check, setCheck] = useState<{ operationId: string; targetId: string } | null>(null);
	const checkOperation = useOperation(client, check?.operationId ?? null);
	const startCheck = useMutation({
		mutationFn: (targetId: string) =>
			client.call(routes.targetsProbe, { ...emptyInput, params: { id: workspaceId, targetId } }),
		onSuccess: (value, targetId) => setCheck({ operationId: value.operationId, targetId }),
	});
	useEffect(() => {
		const result = checkOperation.data?.status === "succeeded" ? checkOperation.data.result : null;
		if (result && "targets" in result) queries.setQueryData(["targets", workspaceId], result.targets);
	}, [checkOperation.data, queries, workspaceId]);
	const catalogFor = (control: SettingControl): ModelCatalog | undefined => {
		const targetPath = MODEL_TARGET_PATHS[control.path];
		if (!targetPath || control.access !== "writable") return undefined;
		const targetControl = report.data?.controls.find((candidate) => candidate.path === targetPath);
		const targetId = drafts[targetPath] ?? targetControl?.value ?? "";
		if (targetId === "")
			return {
				models: null,
				defaultModel: null,
				note: `${targetControl?.label ?? targetPath} is automatic, so type an exact model id or choose a target first.`,
			};
		if (inventory.isPending) return { models: null, defaultModel: null, note: `Reading ${targetId}'s models…` };
		if (!inventory.data)
			return {
				models: null,
				defaultModel: null,
				note: `The target list could not be read${inventory.error ? `: ${inventory.error.message}` : "."}`,
			};
		const target = inventory.data.targets.find((row) => row.id === targetId);
		if (!target) return { models: null, defaultModel: null, note: `${targetId} is not a configured target.` };
		const checking =
			check?.targetId === targetId &&
			(startCheck.isPending || checkOperation.data?.status === "queued" || checkOperation.data?.status === "running");
		const checked = check?.targetId === targetId ? checkOperation.data : undefined;
		const source = checking
			? `Asking ${targetId} for its models…`
			: checked?.status === "succeeded"
				? `${targetId} answered at ${formatTime(checked.finishedAt)}: ${target.models.length} ${target.models.length === 1 ? "model" : "models"}.`
				: checked?.status === "failed"
					? `The check did not finish: ${checked.problem.detail} These are the models Clio Coder last read from ${targetId}.`
					: `The models Clio Coder last read from ${targetId}.`;
		return {
			models: target.models.length > 0 ? target.models : target.defaultModel ? [target.defaultModel] : null,
			defaultModel: target.defaultModel,
			note: (
				<>
					{source}
					{target.modelsTruncated ? " The list shows the first 200; choose Another model id for one not shown." : ""}{" "}
					<button
						type="button"
						className="setting-control__check"
						disabled={checking || startCheck.isPending}
						onClick={() => startCheck.mutate(targetId)}
					>
						Check {targetId} again
					</button>
				</>
			),
		};
	};
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
							catalog={catalogFor(control)}
						/>
					))}
				</section>
			))}
		</>
	);
}
