import type { Static } from "typebox";
import { Type } from "typebox";
import { AgentRole } from "./enums.js";

/**
 * Identity schemas shared by the journal, the DTOs and the GUI contract (#434). This leaf imports only TypeBox and the vocabulary leaf, so
 * a browser bundle can carry the DTO schemas without the Node modules `ids.ts` and `context.ts` need to mint ids and
 * run the async-local context.
 */

/** RFC 9562 UUIDv7, independent of the provider SDK and existing session/run ids (#434). */
export const UUID_V7_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const CallIdSchema = Type.String({ pattern: `^cal_${UUID_V7_PATTERN}$` });
export const AttemptIdSchema = Type.String({ pattern: `^att_${UUID_V7_PATTERN}$` });
export const ExistingId = Type.String({ minLength: 1, maxLength: 512 });

/**
 * The agent an event acts for: its role and the instance. A session's own and side agents are named by their
 * session, a worker or coordinator by its run, System One by its engine, a process's own agent by the process (#434).
 */
export const TelemetryAgentSchema = Type.Object({ role: AgentRole, id: ExistingId }, { additionalProperties: false });
export type TelemetryAgent = Static<typeof TelemetryAgentSchema>;
