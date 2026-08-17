// ---------------------------------------------------------------------------
// Time helpers
//
// minotor represents Time as *minutes* from midnight (may exceed 1440 for
// services running past midnight). Ported from transit-router's src/time.js.
// ---------------------------------------------------------------------------

export type DayType = 'weekday' | 'saturday' | 'sunday';

/** Zero-pads a number to two digits. */
export function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/** Minutes from midnight from a human-readable "HH:mm" (or "HH:mm:ss") string. */
export function hmToMinutes(hm: string): number {
	const [h, m] = String(hm).split(':').map(Number);
	if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) {
		throw new Error(`Ungültige Zeit "${hm}", erwartet "HH:mm".`);
	}
	return h * 60 + m;
}

/** "HH:mm" from a minotor Time (minutes from midnight); hours wrap at 24. */
export function minutesToClock(time: number): string {
	const h = Math.floor(time / 60) % 24;
	const m = Math.floor(time % 60);
	return `${pad2(h)}:${pad2(m)}`;
}

/** "HH:mm:ss" from seconds-from-midnight; wraps at 24h so post-midnight delays format cleanly. */
export function secondsToClock(totalSeconds: number): string {
	const s = ((totalSeconds % 86400) + 86400) % 86400;
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

/**
 * The delay day type of a Date: 'weekday' (Mon-Fri), 'saturday', or 'sunday'.
 * Mirrors how transit-router's aggregate.py buckets days; no holiday calendar.
 */
export function dayTypeOf(date: Date): DayType {
	const dow = date.getDay(); // 0 = Sunday ... 6 = Saturday
	if (dow === 0) return 'sunday';
	if (dow === 6) return 'saturday';
	return 'weekday';
}

/** Human-readable delay: "+1m 52s late", "-30s early", "on time". */
export function formatDelay(seconds: number | null): string | null {
	if (seconds == null) return null;
	if (seconds === 0) return 'on time';
	const abs = Math.abs(seconds);
	const m = Math.floor(abs / 60);
	const s = abs % 60;
	const mag = m > 0 ? `${m}m ${s}s` : `${s}s`;
	return `${seconds > 0 ? '+' : '-'}${mag} ${seconds > 0 ? 'late' : 'early'}`;
}
