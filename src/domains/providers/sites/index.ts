/**
 * The turn-level pre-turn sites, in the order their hints are delivered.
 *
 * A new pre-turn case is one definition file here, one entry in this list, and
 * one `DECISION_SITES` entry. The brief discovers bound sites from the list,
 * batches their questions into the request it already makes, and the hint and
 * ledger paths read every site the same way. The relevance sites are not
 * listed because their subjects come from catalogs only the composition root
 * can read; `createTurnRelevanceStore` adds them.
 */

import type { PreTurnSite } from "../pre-turn-brief.js";
import { dispatchForecastSite } from "./dispatch-forecast.js";
import { turnScopeSite } from "./turn-scope.js";

export {
	type DispatchForecast,
	type DispatchShape,
	dispatchForecastHint,
	dispatchForecastSite,
} from "./dispatch-forecast.js";
export { TURN_SCOPE_HINT, type TurnScope, turnScopeSite } from "./turn-scope.js";

export const TURN_SITES: ReadonlyArray<PreTurnSite<unknown>> = [
	turnScopeSite as PreTurnSite<unknown>,
	dispatchForecastSite as PreTurnSite<unknown>,
];
