/**
 * The stations searched most recently, kept in localStorage so the autocomplete
 * can offer them back on the next visit. Only what it takes to search one again
 * is stored: the resolved stop id and the name to show.
 *
 * The id is the GTFS source stop id, not minotor's internal one: the internal
 * ids are positions in the feed's stops.txt, so a data:build against a newer
 * feed shifts them and a stored one then resolves to a different station.
 */

export type RecentStation = { id: string; name: string };

const KEY = 'recent-stations.v2';

/** The key v2 replaced, whose ids are the internal ones that don't survive a build. */
const LEGACY_KEY = 'recent-stations';

/** How many are kept - searching another station drops the oldest. */
const MAX = 5;

export function recentStations(): RecentStation[] {
	try {
		localStorage.removeItem(LEGACY_KEY);
		const raw = localStorage.getItem(KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(e): e is RecentStation =>
					typeof e?.id === 'string' && typeof e?.name === 'string' && e.id !== ''
			)
			.slice(0, MAX);
	} catch {
		// Storage blocked (private mode) or holding something we didn't write:
		// no recent stations is a fine answer, an exception isn't.
		return [];
	}
}

/** Puts a station at the front of the list and returns the list as it now stands. */
export function rememberStation(station: RecentStation): RecentStation[] {
	const next = [station, ...recentStations().filter((r) => r.id !== station.id)].slice(0, MAX);
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {
		/* Nothing to do if storage is blocked or full; the list just won't persist. */
	}
	return next;
}
