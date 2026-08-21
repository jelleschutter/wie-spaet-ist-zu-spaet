/**
 * Builds the minotor stops index and one timetable per weekday from the GTFS feed.
 *
 * minotor's `.bin` files are its own protobuf format and its GTFS parser is what
 * defines them (route patterns, stop adjacency, trip continuations), so this
 * drives minotor's CLI rather than reimplementing its serializer.
 *
 * Two quirks of minotor 11.5.0 shape this:
 *
 *   * `parse-stops` is unusable - it declares `-s, --outputPath` but reads
 *     `options.stopsOutputPath`, so it always crashes on an undefined path.
 *   * `parse-gtfs` writes both a timetable *and* a stops file, and its
 *     `parseStops()` takes no date, so the stops index is date-independent.
 *
 * So we run `parse-gtfs` once per weekday and keep the stops file from the first
 * run. Each run streams the feed's 1.4 GB stop_times.txt and takes ~8 minutes,
 * which makes this - not the delay statistics - the long pole of a cold build.
 *
 * It stays a child process rather than an import: the parser needs a heap far
 * larger than the default, and `--max-old-space-size` can only be set at startup.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';

import { isHoliday } from '../src/lib/transit/holidays.ts';
import {
	DAY_TYPES,
	OUT_DIR,
	REPO,
	WORK_DIR,
	addDays,
	die,
	ensureDir,
	isoDate,
	log,
	mb,
	timed,
	weekdayIndex
} from './layout.js';
import { findMember, openMember, readCentralDirectory, readMember } from './zip.js';

const MINOTOR_CLI = path.join(REPO, 'node_modules', 'minotor', 'dist', 'cli.mjs');

// The geops feed uses standard GTFS route types (0 tram, 2 rail, 3 bus, ...), not
// the extended 100-1799 range, so minotor's `standard` profile is the one that
// maps them onto its own RouteTypes enum.
const GTFS_PROFILE = 'standard';

// Peak resident memory of one parse-gtfs run over the 2026 feed, measured: the
// parser holds one route pattern per distinct stop list, with the arrival and
// departure arrays of every trip on it, and lets go of none of it until the
// last of the 30 M stop_times rows has been read.
const PARSE_PEAK_MB = 1400;

// Node's default heap is nowhere near that, so the parse gets its own cap with
// about three times the headroom it needs - and no more than that.
//
// --max-old-space-size is a promise about how much V8 may use before it has to
// collect in earnest, not a reservation. Set it above what the machine can
// actually back and V8 does the rational thing: it postpones the major GC it
// doesn't believe it needs, until the kernel steps in. On Linux that arrives as
// a bare SIGKILL - no exception, no message, nothing after whatever line the
// parser last happened to print.
const NODE_HEAP_MB = 4096;

// So a smaller machine gets a proportionally smaller promise and collects more
// often instead. The share is of physical memory only: swap keeps the process
// alive, but sizing the heap to it would just move the thrashing around.
const HEAP_SHARE = 0.6;
// ...though never below what the live set actually needs, or V8 spends the whole
// parse collecting and still fails - just with a clearer message.
const MIN_HEAP_MB = 1536;

/** The largest heap we can promise V8 here without inviting the OOM killer. */
export function heapLimitMb() {
	const affordable = Math.floor((os.totalmem() * HEAP_SHARE) / 1e6);
	return Math.max(MIN_HEAP_MB, Math.min(NODE_HEAP_MB, affordable));
}

/**
 * Why the child stopped, in terms the caller can act on.
 *
 * spawnSync reports no exit code at all for anything that isn't an ordinary
 * exit and puts the reason in `signal` or `error` instead - so a parse the
 * kernel killed used to be reported here as "exit null", which says nothing
 * about what to do about it.
 */
function whyItStopped(result, heapMb) {
	if (result.error) return `${result.error.code ?? 'spawn failed'} - ${result.error.message}`;
	if (result.status === 0) return 'exited cleanly without writing a timetable';
	if (result.signal === 'SIGKILL') {
		return (
			'killed with SIGKILL - nothing inside the parser fails that way, so the kernel ' +
			`ran the machine out of memory. It had a ${heapMb} MB heap on a ` +
			`${(os.totalmem() / 1e9).toFixed(1)} GB machine, and the parse needs about ` +
			`${PARSE_PEAK_MB} MB resident; add swap, use a bigger machine, or build the ` +
			'timetables elsewhere and copy static/data across'
		);
	}
	if (result.signal) return `killed by ${result.signal}`;
	return `exit ${result.status}`;
}

/** The last `count` lines of a file, without reading all of it. */
function tailOf(file, count) {
	let size;
	try {
		size = fs.statSync(file).size;
	} catch {
		return '(no output)';
	}
	if (size === 0) return '(no output)';
	const want = Math.min(size, 64 << 10);
	const buffer = Buffer.allocUnsafe(want);
	const fd = fs.openSync(file, 'r');
	try {
		fs.readSync(fd, buffer, 0, want, size - want);
	} finally {
		fs.closeSync(fd);
	}
	return buffer.toString('utf8').trimEnd().split('\n').slice(-count).join('\n');
}

/** Lines in a file, counted without holding it in memory. */
function lineCount(file) {
	let lines = 0;
	let fd;
	try {
		fd = fs.openSync(file, 'r');
	} catch {
		return 0;
	}
	try {
		const buffer = Buffer.allocUnsafe(1 << 20);
		let read;
		while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
			for (let i = 0; i < read; i++) if (buffer[i] === 10) lines++;
		}
	} finally {
		fs.closeSync(fd);
	}
	return lines;
}

/** The feed's validity window from feed_info.txt, or null if it declares none. */
export async function feedWindow(gtfsZip) {
	const { entries } = readCentralDirectory(gtfsZip);
	const entry = findMember(entries, 'feed_info.txt');
	if (!entry) return null;

	const text = (await readMember(gtfsZip, entry)).toString('utf8').replace(/^﻿/, '');
	const [header, first] = text.split(/\r?\n/);
	if (!first) return null;
	const columns = header.split(',').map((name) => name.trim());
	const values = first.split(',');
	const field = (name) => values[columns.indexOf(name)]?.trim();

	const parse = (raw) => {
		const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw ?? '');
		if (!match) return null;
		return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	};
	const start = parse(field('feed_start_date'));
	const end = parse(field('feed_end_date'));
	return start && end ? [start, end] : null;
}

/**
 * One date per weekday, taken from the fortnight around `today`.
 *
 * The app answers "what leaves around now", so each weekday is represented by its
 * occurrence nearest to today - today itself for today's weekday, and at most
 * three days out for the others. That keeps every timetable inside the
 * last-7-days/today/next-7-days window and current with the live schedule, rather
 * than describing some arbitrary week of the annual feed.
 *
 * Nationwide holidays are skipped: they run the Sunday timetable, so taking e.g.
 * a 1 August Tuesday as "the Tuesday timetable" would describe the wrong service
 * pattern. Sunday is picked the same way, from an ordinary Sunday.
 */
export function timetableDates(today, window = null) {
	const inWindow = (date) => window === null || (window[0] <= date && date <= window[1]);
	const chosen = new Map();

	for (const [index, dayType] of DAY_TYPES.entries()) {
		const ahead = (index - weekdayIndex(today) + 7) % 7; // 0..6 days forward
		// The same weekday also sits at `ahead - 7`, `ahead + 7`, ... Try them
		// nearest-first: within +/-7 days normally, wider only if holidays force it.
		const offsets = [-3, -2, -1, 0, 1, 2, 3]
			.map((week) => ahead + 7 * week)
			.sort((a, b) => Math.abs(a) - Math.abs(b) || (a < 0 ? 1 : -1));
		const candidates = offsets.map((offset) => addDays(today, offset));

		let usable = candidates.filter((date) => inWindow(date) && !isHoliday(date));
		// Every nearby date is a holiday - fall back to any in-window occurrence.
		if (usable.length === 0) usable = candidates.filter(inWindow);
		if (usable.length === 0) {
			die(`no usable ${dayType} within three weeks of ${isoDate(today)} inside the feed window.`);
		}
		chosen.set(dayType, usable[0]);
	}
	return chosen;
}

function stampFor(gtfsZip, date) {
	const stat = fs.statSync(gtfsZip);
	const mtime = Math.floor(stat.mtimeMs / 1000);
	return `${isoDate(date)}|${stat.size}|${mtime}|${GTFS_PROFILE}`;
}

function gzipTo(source, dest) {
	ensureDir(path.dirname(dest));
	// Node's gzip always stamps mtime 0, so the output stays byte-identical
	// between runs on unchanged input and re-generating churns nothing.
	const data = zlib.gzipSync(fs.readFileSync(source), { level: 9 });
	fs.writeFileSync(dest, data);
	return data.length;
}

/**
 * Writes stops.bin.gz and timetable.<weekday>.bin.gz.
 *
 * @returns {Promise<Record<string, string>>} the date used per day type
 */
export async function build(
	gtfsZip,
	dates,
	{ force = false, node = process.execPath, heapMb = heapLimitMb() } = {}
) {
	if (!fs.existsSync(MINOTOR_CLI)) {
		die(`minotor CLI not found at ${MINOTOR_CLI} - run \`npm install\` first.`);
	}

	const window = await feedWindow(gtfsZip);
	if (window) {
		log(`  feed valid ${isoDate(window[0])} .. ${isoDate(window[1])}`);
		const outside = [...dates.values()]
			.filter((date) => !(window[0] <= date && date <= window[1]))
			.map(isoDate);
		if (outside.length) {
			die(`dates outside the feed's validity window: ${outside.join(', ')}`);
		}
	}

	log(`  ${heapMb} MB heap per parse, ${(os.totalmem() / 1e9).toFixed(1)} GB on this machine`);
	// Twice the peak is what makes a run comfortable; below that the parse and
	// the system are competing, and no heap size fixes it. Worth saying before
	// the eight minutes rather than after, because without swap the only symptom
	// is the process vanishing mid-parse.
	if (os.totalmem() < 2 * PARSE_PEAK_MB * 1e6) {
		log(
			`  warning: one parse peaks at ~${PARSE_PEAK_MB} MB resident, which leaves this ` +
				`machine little room for anything else. Give it swap, or build the ` +
				`timetables somewhere larger and copy static/data across.`
		);
	}

	ensureDir(WORK_DIR);
	ensureDir(OUT_DIR);
	// Drop timetables from an earlier run whose day types no longer exist.
	for (const name of fs.readdirSync(OUT_DIR)) {
		const match = /^timetable\.(.+)\.bin\.gz$/.exec(name);
		if (match && !DAY_TYPES.includes(match[1])) {
			log(`  removing stale ${name}`);
			fs.unlinkSync(path.join(OUT_DIR, name));
		}
	}

	let stopsSource = null;
	const used = {};

	for (const dayType of DAY_TYPES) {
		const date = dates.get(dayType);
		used[dayType] = isoDate(date);

		const timetableBin = path.join(WORK_DIR, `timetable.${dayType}.bin`);
		const stopsBin = path.join(WORK_DIR, `stops.${dayType}.bin`);
		const stampFile = path.join(WORK_DIR, `timetable.${dayType}.stamp`);
		// minotor's progress goes to stdout and its per-row complaints to stderr;
		// keeping them apart is what lets a good run say how many rows it skipped
		// without having to guess which lines were warnings.
		const logFile = path.join(WORK_DIR, `parse-gtfs.${dayType}.log`);
		const warnFile = path.join(WORK_DIR, `parse-gtfs.${dayType}.warnings.log`);
		const want = stampFor(gtfsZip, date);
		const fresh =
			!force &&
			fs.existsSync(timetableBin) &&
			fs.existsSync(stopsBin) &&
			fs.existsSync(stampFile) &&
			fs.readFileSync(stampFile, 'utf8').trim() === want;

		if (fresh) {
			log(`  ${dayType} (${isoDate(date)}): reusing parsed timetable`);
		} else {
			await timed(`${dayType} (${isoDate(date)})`, async () => {
				log(`  ${dayType} (${isoDate(date)}): parsing GTFS...`);
				// The child's output goes straight to files rather than through a
				// pipe: the feed is worth tens of thousands of "missing arrival or
				// departure time" warnings per run, which are normal and which
				// nobody wants seven times over in a CI log.
				const logFd = fs.openSync(logFile, 'w');
				const warnFd = fs.openSync(warnFile, 'w');
				let result;
				try {
					result = spawnSync(
						node,
						[
							`--max-old-space-size=${heapMb}`,
							MINOTOR_CLI,
							'parse-gtfs',
							'--date',
							isoDate(date),
							'--profileName',
							GTFS_PROFILE,
							'--timetableOutputPath',
							timetableBin,
							'--stopsOutputPath',
							stopsBin,
							gtfsZip
						],
						{ stdio: ['ignore', logFd, warnFd] }
					);
				} finally {
					fs.closeSync(logFd);
					fs.closeSync(warnFd);
				}
				if (result.status !== 0 || !fs.existsSync(timetableBin)) {
					log(`    last of ${path.relative(REPO, logFile)}:`);
					log(tailOf(logFile, 8));
					log(`    last of ${path.relative(REPO, warnFile)}:`);
					log(tailOf(warnFile, 8));
					die(`minotor parse-gtfs for ${isoDate(date)}: ${whyItStopped(result, heapMb)}.`);
				}
				const warnings = lineCount(warnFile);
				if (warnings > 0) {
					// Said out loud because they look alarming and are not: the feed
					// carries rows the parser can do nothing with, it skips them, and
					// that is the whole story unless the exit code says otherwise.
					log(
						`    skipped ${warnings.toLocaleString('en-US')} rows the feed left ` +
							`incomplete, listed in ${path.relative(REPO, warnFile)}`
					);
				}
			});
			fs.writeFileSync(stampFile, want);
		}

		const size = gzipTo(timetableBin, path.join(OUT_DIR, `timetable.${dayType}.bin.gz`));
		log(
			`    timetable.${dayType}.bin.gz  ${mb(fs.statSync(timetableBin).size)} -> ${mb(size)}`
		);
		if (stopsSource === null) stopsSource = stopsBin;
	}

	const size = gzipTo(stopsSource, path.join(OUT_DIR, 'stops.bin.gz'));
	log(`    stops.bin.gz  ${mb(fs.statSync(stopsSource).size)} -> ${mb(size)}`);
	return used;
}

/**
 * Every BPUIC the feed knows, taken from the `<bpuic>[:<platform>]` stop ids.
 *
 * Delay rows for stops outside the feed can never be looked up, so they are
 * dropped instead of shipped.
 *
 * @returns {Promise<Set<number>>}
 */
export async function bpuics(gtfsZip) {
	const { entries } = readCentralDirectory(gtfsZip);
	const entry = findMember(entries, 'stops.txt');
	if (!entry) die(`stops.txt is missing from ${gtfsZip}`);

	const found = new Set();
	const lines = readline.createInterface({
		input: openMember(gtfsZip, entry),
		crlfDelay: Infinity
	});
	let idColumn = -1;
	for await (const line of lines) {
		if (idColumn < 0) {
			idColumn = line
				.replace(/^﻿/, '')
				.split(',')
				.map((name) => name.replace(/^"|"$/g, '').trim())
				.indexOf('stop_id');
			if (idColumn < 0) die('stops.txt has no stop_id column');
			continue;
		}
		if (!line) continue;
		const head = csvField(line, idColumn).split(':', 1)[0].trim();
		if (/^\d+$/.test(head)) found.add(Number(head));
	}
	return found;
}

/**
 * The nth comma-separated field of a CSV row, honouring double quotes.
 *
 * stop_id is the first column in this feed and never quoted, but stop_name two
 * columns over very much can be ("Zürich, Bahnhof") - so a plain split would put
 * the wrong text under the wrong name the day the feed reorders its columns.
 */
function csvField(row, index) {
	let at = 0;
	for (let field = 0; ; field++) {
		let quoted = false;
		const start = at;
		while (at < row.length) {
			const char = row[at];
			if (char === '"') quoted = !quoted;
			else if (char === ',' && !quoted) break;
			at++;
		}
		if (field === index) return row.slice(start, at).replace(/^"|"$/g, '');
		if (at >= row.length) return '';
		at++; // the comma
	}
}
