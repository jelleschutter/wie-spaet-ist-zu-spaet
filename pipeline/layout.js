/**
 * Shared constants, paths and small helpers for the data pipeline.
 *
 * Dates are plain `Date` objects at *local* midnight, which is what
 * src/lib/transit/holidays.ts expects - the pipeline imports that module rather
 * than keeping a second copy of the holiday list. CI runs in UTC, and local
 * midnight exists on every Swiss DST day, so the two never disagree.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..');

export const RAW_DIR = path.join(REPO, 'data', 'raw');
export const WORK_DIR = path.join(REPO, 'data', 'work');
export const OUT_DIR = path.join(REPO, 'static', 'data');

export const GTFS_ZIP = path.join(RAW_DIR, 'gtfs_complete.zip');
export const ISTDATEN_DIR = path.join(RAW_DIR, 'istdaten');
/** One reduced-sample file per service day, grouped by day type. */
export const SAMPLES_DIR = path.join(WORK_DIR, 'delay-samples');

// Day types are calendar weekdays, Monday first. The names (not the indices) are
// what the browser sees, so the wire format never has to know whether a weekday
// index counts from Monday or from Sunday.
export const DAY_TYPES = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday'
];

// Pools of day types aggregated on top of the single weekdays: the app lets the
// visitor trade a weekday's own pattern for more observations. Each is written
// like a day type, to delays/<group>/. Holidays count as Sunday, so they land in
// the weekend. Keep in sync with DelayGroup in src/lib/transit/delays.ts.
export const DELAY_GROUPS = {
	weekdays: DAY_TYPES.slice(0, 5),
	weekend: DAY_TYPES.slice(5),
	all: DAY_TYPES
};

// Delay rows are sharded by `bpuic % BUCKETS` per day type: enough buckets that
// one lookup fetches ~20 KB, few enough to stay a manageable file count.
export const BUCKETS = 1024;

// A weekday's aggregation runs in this many passes over `bpuic % AGG_CHUNKS`,
// which bounds peak memory no matter how many months are in the samples (a year
// of one weekday is ~117 M rows, and the exact percentile has to hold every
// observation of a group at once). Four passes measure ~600 MB peak RSS; the
// samples are re-read per pass, which costs about a second each.
export const AGG_CHUNKS = 4;

// A delay row: lineIdx u16 | plannedDepMin u16 | catchBuffer i16 | avg i16 |
// samples u8 | dayOffset i8. Keep in sync with src/lib/transit/delays.ts.
export const ROW_SIZE = 10;
export const FORMAT_VERSION = 2;

export const I16_MIN = -32768;
export const I16_MAX = 32767;

export function log(message = '') {
	process.stdout.write(`${message}\n`);
}

export function step(title) {
	log(`\n=== ${title}`);
}

export function mb(byteCount) {
	return `${(byteCount / 1e6).toFixed(1)} MB`;
}

/** Thousands separators, fixed to en-US so CI logs don't depend on the locale. */
export function num(value) {
	return value.toLocaleString('en-US');
}

export function duration(seconds) {
	return seconds < 90 ? `${seconds.toFixed(0)}s` : `${(seconds / 60).toFixed(1)}min`;
}

/** Runs `body`, reporting how long it took - but only when it succeeds. */
export async function timed(label, body) {
	const started = performance.now();
	const result = await body();
	log(`  ${label} took ${duration((performance.now() - started) / 1000)}`);
	return result;
}

export function die(message) {
	log(`\nerror: ${message}`);
	process.exit(1);
}

export function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// ------------------------------------------------------------------ dates

/** "YYYY-MM-DD" of a local-midnight date. */
export function isoDate(date) {
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

/** A local-midnight date from "YYYY-MM-DD". */
export function parseIsoDate(text) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
	if (!match) throw new Error(`not a YYYY-MM-DD date: "${text}"`);
	const [, year, month, day] = match;
	const date = new Date(Number(year), Number(month) - 1, Number(day));
	if (date.getMonth() !== Number(month) - 1) throw new Error(`no such date: "${text}"`);
	return date;
}

export function today() {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** `days` after `date`; the Date constructor normalises out-of-range days. */
export function addDays(date, days) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Weekday as an index into DAY_TYPES, i.e. Monday = 0. */
export function weekdayIndex(date) {
	return (date.getDay() + 6) % 7;
}

/**
 * The `count` whole months before `today`, oldest first, as [year, month] pairs.
 *
 * The current month is skipped: each monthly Ist-Daten archive is published only
 * after the month has ended.
 */
export function lastCompleteMonths(from, count) {
	let year = from.getFullYear();
	let month = from.getMonth() + 1;
	const out = [];
	for (let i = 0; i < count; i++) {
		month -= 1;
		if (month === 0) {
			month = 12;
			year -= 1;
		}
		out.push([year, month]);
	}
	return out.reverse();
}

/**
 * Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
 *
 * Used by the sample parser, which sees millions of dates per file and must not
 * allocate a Date for any of them.
 */
export function daysFromCivil(year, month, day) {
	const y = year - (month <= 2 ? 1 : 0);
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const doy = Math.trunc((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}
