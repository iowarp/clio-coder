// Selected, unmodified DTOs from the retained S10-workbench-protocol4 events.jsonl.
// The initial snapshot belongs to an older session; New then reuses turn-1.
import recorded from "./fixtures/workbench-response.json" with { type: "json" };
import { validateServerEvent } from "../src/protocol.ts";
import { appReducer, initialAppState, parseBootstrapPayload } from "../src/state.ts";
import { bootstrapFixture, workspaceFixture } from "./fixtures.ts";

export const responseEvents = recorded.events.map(validateServerEvent);
export function responseInitialState() {
	const projectId = responseEvents[0]!.projectId!;
	const workspace = workspaceFixture(projectId);
	return appReducer(initialAppState, {
		type: "bootstrap.loaded",
		payload: parseBootstrapPayload({
			...bootstrapFixture(),
			workspaceInstanceId: responseEvents[0]!.workspaceInstanceId,
			openProjectId: projectId,
			workspace: { ...workspace, ...recorded.initial },
		}),
	});
}

export function responseCompletedWorkspace() {
	return parseBootstrapPayload({
		...bootstrapFixture(),
		openProjectId: responseEvents[0]!.projectId!,
		workspace: { ...workspaceFixture(responseEvents[0]!.projectId!), ...recorded.completed },
	}).workspace!;
}
