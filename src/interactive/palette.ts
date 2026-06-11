import { fgSequence, GLYPH, SGR_DIM, SGR_RESET } from "./theme/index.js";

export const RESET = SGR_RESET;
export const DIM = SGR_DIM;
export const TEAL = fgSequence("accent");
export const BLUE_REASON = fgSequence("reason");
export const GREEN_OK = fgSequence("success");
export const AMBER = fgSequence("warning");
export const RED_CRIT = fgSequence("error");
export const AGENT_GLYPH = GLYPH.agent;
export const USER_GLYPH = GLYPH.user;
