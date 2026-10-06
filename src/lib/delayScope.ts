/**
 * Which days the delay statistics are drawn from, remembered in localStorage so
 * the choice sticks across visits. Mo-Fr (or the weekend) is the default: several
 * times the observations of a single weekday, for services that mostly run alike.
 */

import { DELAY_SCOPES, type DelayScope } from '$lib/transit';

const KEY = 'delay-scope';

export const DEFAULT_DELAY_SCOPE: DelayScope = 'group';

export function savedDelayScope(): DelayScope {
	try {
		const saved = localStorage.getItem(KEY);
		return DELAY_SCOPES.includes(saved as DelayScope) ? (saved as DelayScope) : DEFAULT_DELAY_SCOPE;
	} catch {
		// Storage blocked (private mode): the default is a fine answer.
		return DEFAULT_DELAY_SCOPE;
	}
}

export function saveDelayScope(scope: DelayScope): void {
	try {
		localStorage.setItem(KEY, scope);
	} catch {
		/* Nothing to do if storage is blocked or full; the choice just won't persist. */
	}
}
