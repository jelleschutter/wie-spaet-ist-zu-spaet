// ---------------------------------------------------------------------------
// Swiss nationwide public holidays, which run the Sunday timetable.
//
// Only the holidays that apply in every canton are listed - cantonal ones
// (Fasnachtsmontag, Bettag, ...) vary too much to treat nationally.
//
// Keep in sync with pipeline/holidays.py.
// ---------------------------------------------------------------------------

/** Gregorian Easter Sunday (anonymous Gregorian algorithm), as a local date. */
function easterSunday(year: number): Date {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const total = h + l - 7 * m + 114;
	return new Date(year, Math.floor(total / 31) - 1, (total % 31) + 1);
}

function key(month: number, day: number): string {
	return `${month}-${day}`;
}

function keyOf(date: Date): string {
	return key(date.getMonth() + 1, date.getDate());
}

function offsetFrom(base: Date, days: number): Date {
	return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

/** The nationwide holidays of a year, keyed by "month-day". */
function holidaysOf(year: number): Map<string, string> {
	const easter = easterSunday(year);
	return new Map([
		[key(1, 1), 'Neujahr'],
		[key(1, 2), 'Berchtoldstag'],
		[keyOf(offsetFrom(easter, -2)), 'Karfreitag'],
		[keyOf(offsetFrom(easter, 1)), 'Ostermontag'],
		[keyOf(offsetFrom(easter, 39)), 'Auffahrt'],
		[keyOf(offsetFrom(easter, 50)), 'Pfingstmontag'],
		[key(8, 1), 'Bundesfeier'],
		[key(12, 25), 'Weihnachten'],
		[key(12, 26), 'Stephanstag']
	]);
}

const cache = new Map<number, Map<string, string>>();

/** The holiday's German name, or null on an ordinary day. */
export function holidayName(date: Date): string | null {
	const year = date.getFullYear();
	let byDay = cache.get(year);
	if (!byDay) cache.set(year, (byDay = holidaysOf(year)));
	return byDay.get(keyOf(date)) ?? null;
}

export function isHoliday(date: Date): boolean {
	return holidayName(date) !== null;
}
