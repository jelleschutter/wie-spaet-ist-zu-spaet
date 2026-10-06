#!/usr/bin/env node
/**
 * Builds everything the deployed site serves out of static/data/.
 *
 *     node pipeline/build.js
 *
 * Three steps, each skippable and each resumable:
 *
 *   1. download    the geops GTFS feed and the last 12 monthly Ist-Daten archives
 *   2. timetables  one minotor timetable per weekday and its trips past midnight,
 *                  plus the stops index
 *   3. delays      per-station delay statistics, sharded per weekday and per
 *                  pool of weekdays (Mo-Fr, weekend, all)
 *
 * Nothing else runs before deployment: `npm run build` only bundles the frontend
 * around the files this produces.
 *
 * Useful flags:
 *
 *     --days 3            only process three Ist-Daten days (fast smoke test)
 *     --months 1          only fetch/aggregate the most recent month
 *     --only delays       re-run a single step
 *     --skip delays       skip a step (repeat the flag for more than one)
 *     --today 2026-08-17  anchor the timetable dates and month list to a fixed day
 *     --prune             fetch each Ist-Daten month just in time and delete it after
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import * as delaysStep from './delays.js';
import * as downloadStep from './download.js';
import * as timetablesStep from './timetables.js';
import {
	AGG_CHUNKS,
	BUCKETS,
	DAY_TYPES,
	DELAY_GROUPS,
	FORMAT_VERSION,
	GTFS_ZIP,
	OUT_DIR,
	WORK_DIR,
	die,
	duration,
	ensureDir,
	isoDate,
	lastCompleteMonths,
	log,
	mb,
	num,
	parseIsoDate,
	step,
	today as todayDate
} from './layout.js';

const STEPS = ['download', 'timetables', 'delays'];

const USAGE = `Build the static data bundle in static/data/.

  node pipeline/build.js [options]

  --months N        how many whole months of Ist-Daten (default: 12)
  --days N          stop after N Ist-Daten service days (for smoke tests)
  --min-samples N   drop services observed fewer than N times (default: 1)
  --chunks N        aggregation passes per day type, lower = more memory (default: ${AGG_CHUNKS})
  --only STEP       run just one step: ${STEPS.join(' | ')}
  --skip STEP       skip a step; repeat the flag to skip more than one
  --force           re-parse/re-extract even when outputs look current
  --prune           download each Ist-Daten archive right before it is read and
                    delete it again afterwards: bounds peak disk to one month
                    instead of ~15 GB, at the cost of re-downloading on the next
                    run (for CI)
  --node PATH       node executable for the minotor CLI (default: this one)
  --heap MB         heap cap for the GTFS parse; the default is sized to the
                    machine, raise it only where there is RAM to back it
  --today DATE      pretend today is this date (YYYY-MM-DD), for reproducible runs
`;

function parseCli() {
	let parsed;
	try {
		parsed = parseArgs({
			options: {
				months: { type: 'string', default: '12' },
				days: { type: 'string' },
				'min-samples': { type: 'string', default: '1' },
				chunks: { type: 'string', default: String(AGG_CHUNKS) },
				only: { type: 'string' },
				skip: { type: 'string', multiple: true, default: [] },
				force: { type: 'boolean', default: false },
				prune: { type: 'boolean', default: false },
				node: { type: 'string', default: process.execPath },
				heap: { type: 'string' },
				today: { type: 'string' },
				help: { type: 'boolean', default: false }
			},
			allowPositionals: false
		});
	} catch (error) {
		die(`${error.message}\nRun with --help for the available flags.`);
	}

	const { values } = parsed;
	if (values.help) {
		log(USAGE);
		process.exit(0);
	}

	const integer = (name, raw, { min = 1 } = {}) => {
		if (raw === undefined) return null;
		const value = Number(raw);
		if (!Number.isInteger(value) || value < min) {
			die(`--${name} expects an integer >= ${min}, got "${raw}"`);
		}
		return value;
	};
	for (const [name, value] of [
		['only', values.only],
		...values.skip.map((skip) => ['skip', skip])
	]) {
		if (value !== undefined && !STEPS.includes(value)) {
			die(`--${name} expects one of ${STEPS.join(', ')}, got "${value}"`);
		}
	}

	return {
		months: integer('months', values.months),
		days: integer('days', values.days),
		minSamples: integer('min-samples', values['min-samples'], { min: 0 }),
		chunks: integer('chunks', values.chunks),
		only: values.only,
		skip: values.skip,
		force: values.force,
		prune: values.prune,
		node: values.node,
		heap: integer('heap', values.heap, { min: 512 }),
		today: values.today ? parseIsoDate(values.today) : todayDate()
	};
}

const wanted = (args, name) => (args.only ? args.only === name : !args.skip.includes(name));

/** The meta.json on disk, so a partial re-run doesn't drop other steps' facts. */
function loadMeta() {
	const file = path.join(OUT_DIR, 'meta.json');
	if (!fs.existsSync(file)) return {};
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return {};
	}
}

async function main() {
	const args = parseCli();
	const started = performance.now();
	// Only what this run actually rebuilds; merged over the meta.json on disk at
	// the end, so running two steps separately (or in parallel) keeps both.
	const meta = {};
	ensureDir(OUT_DIR);
	ensureDir(WORK_DIR);

	const months = lastCompleteMonths(args.today, args.months);
	const label = ([year, month]) => `${year}-${String(month).padStart(2, '0')}`;
	log(`wie-spaet-ist-zu-spaet data build   (today ${isoDate(args.today)})`);
	log(`  Ist-Daten months: ${label(months[0])} .. ${label(months.at(-1))}`);

	// ------------------------------------------------------------- download
	if (wanted(args, 'download')) {
		step('Downloading upstream feeds');
		await downloadStep.gtfs();
		// The Ist-Daten are 15 GB and only the delays step reads them - with
		// --prune it fetches them one archive at a time instead.
		if (wanted(args, 'delays') && !args.prune) await downloadStep.istdaten(months);
	}
	if (!fs.existsSync(GTFS_ZIP)) die(`${GTFS_ZIP} is missing - run the download step first.`);

	// ----------------------------------------------------------- timetables
	if (wanted(args, 'timetables')) {
		step('Building timetables (minotor)');
		const window = await timetablesStep.feedWindow(GTFS_ZIP);
		const dates = timetablesStep.timetableDates(args.today, window);
		log('  dates (nearest occurrence of each weekday):');
		for (const [dayType, date] of dates) {
			const offset = Math.round((date - args.today) / 86400000);
			const when = offset === 0 ? 'today' : `${offset > 0 ? '+' : ''}${offset}d`;
			log(`    ${dayType.padEnd(9)} ${isoDate(date)} (${when})`);
		}
		meta.timetableDates = await timetablesStep.build(GTFS_ZIP, dates, {
			force: args.force,
			node: args.node,
			// undefined, not null: that is what lets build() fall back to its own default.
			heapMb: args.heap ?? undefined
		});
	}

	// --------------------------------------------------------------- delays
	if (wanted(args, 'delays')) {
		step('Reading Ist-Daten');
		// Every month of the window, on disk or not: for one whose archive can't be
		// read, extract() uses the samples an earlier run left behind.
		const byPath = new Map(months.map((month) => [downloadStep.istdatenPath(...month), month]));
		const archives = [...byPath.keys()];
		// With --prune nothing is on disk yet, and the extract loop pulls each
		// archive down as it gets there.
		const fetch = args.prune
			? async (archive) => (await downloadStep.istdaten([byPath.get(archive)])).length > 0
			: null;

		const { days, lines } = await delaysStep.extract(archives, {
			dayLimit: args.days,
			force: args.force,
			fetch,
			prune: args.prune
		});
		const covered = Object.values(days).reduce((total, dates) => total + dates.length, 0);
		if (covered === 0) die('no Ist-Daten service days were processed.');
		log(`  ${num(covered)} service days, ${num(lines.size)} distinct lines`);

		step('Aggregating delays and writing shards');
		const lineTable = [...lines].sort();
		const allowed = await timetablesStep.bpuics(GTFS_ZIP);
		log(`  ${num(allowed.size)} BPUICs in the GTFS feed`);
		const summary = await delaysStep.shard(OUT_DIR, {
			lineTable,
			allowed,
			days,
			minSamples: args.minSamples,
			chunks: args.chunks
		});

		const dayCount = (dayTypes) =>
			dayTypes.reduce((total, dayType) => total + days[dayType].length, 0);
		meta.lines = lineTable;
		meta.delays = {
			dayTypes: summary.dayTypes,
			groups: summary.groups,
			days: Object.fromEntries([
				...DAY_TYPES.filter((dayType) => days[dayType].length > 0).map((dayType) => [
					dayType,
					days[dayType].length
				]),
				...summary.groups.map((group) => [group, dayCount(DELAY_GROUPS[group])])
			]),
			buckets: BUCKETS,
			stations: summary.stations,
			minSamples: args.minSamples
		};
		meta.istdatenMonths = months.map(label);
	}

	// ----------------------------------------------------------------- meta
	step('Writing meta.json');
	const serviceDays = DAY_TYPES.filter((dayType) =>
		fs.existsSync(path.join(OUT_DIR, `timetable.${dayType}.bin.gz`))
	);
	if (serviceDays.length === 0 && wanted(args, 'timetables')) {
		die('no timetable.<weekday>.bin.gz files in static/data - run the timetables step.');
	}
	meta.version = FORMAT_VERSION;
	meta.generatedAt = `${new Date().toISOString().slice(0, 19)}+00:00`;
	if (serviceDays.length > 0) meta.serviceDays = serviceDays;
	else log('  no timetables here - serviceDays left to the run that builds them');

	// Re-read at the last moment: another step may have written since we started.
	const merged = { ...loadMeta(), ...meta };
	merged.lines ??= [];
	fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(merged), 'utf8');

	let totalBytes = 0;
	let totalFiles = 0;
	for (const entry of fs.readdirSync(OUT_DIR, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		totalBytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
		totalFiles++;
	}
	log(`  service days: ${serviceDays.join(', ') || '-'}`);
	log(`  delay day types: ${(merged.delays?.dayTypes ?? []).join(', ') || '-'}`);
	log(`  delay groups: ${(merged.delays?.groups ?? []).join(', ') || '-'}`);
	log(
		`\nDone in ${duration((performance.now() - started) / 1000)}: ` +
			`${mb(totalBytes)} in ${num(totalFiles)} files under static/data/`
	);
}

await main();
