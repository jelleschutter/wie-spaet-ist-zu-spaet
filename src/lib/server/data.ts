import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TransitPlanner } from './planner';
import type { DayType } from './time';

// ---------------------------------------------------------------------------
// One TransitPlanner, loaded once per process. The `.bin` timetables/stops
// load in well under a second; the ~430 MB delay aggregate takes ~20-30s and
// loads in the background (see planner.delaysReady) so the app is usable
// (station search, departure boards without a reliability buffer) right away.
//
// Cached on `globalThis` so `vite dev`'s module HMR doesn't reload the whole
// dataset every time an unrelated server file changes.
//
// Instantiated lazily (via getPlanner(), not a top-level side effect) because
// `vite build`/adapter-node's build step imports +server.ts modules to read
// their static config - a top-level `createPlanner()` call would fire the
// real ~30s data load during the BUILD, not the actual server start.
// ---------------------------------------------------------------------------

const dataDir = join(process.cwd(), 'data');

declare global {
	// eslint-disable-next-line no-var
	var __transitPlanner: TransitPlanner | undefined;
}

function createPlanner(): TransitPlanner {
	const timetableCandidates: Record<DayType, string> = {
		weekday: join(dataDir, 'timetable.weekday.bin'),
		saturday: join(dataDir, 'timetable.saturday.bin'),
		sunday: join(dataDir, 'timetable.sunday.bin')
	};
	const timetablePaths: Partial<Record<DayType, string>> = {};
	for (const [dayType, path] of Object.entries(timetableCandidates) as [DayType, string][]) {
		if (existsSync(path)) timetablePaths[dayType] = path;
	}

	const aggregatePath = join(dataDir, 'actual-data', 'istdaten.agg.csv');

	const planner = new TransitPlanner({
		timetablePaths,
		stopsPath: join(dataDir, 'stops.bin'),
		didokPath: join(dataDir, 'stops.didok.csv'),
		aggregatePath: existsSync(aggregatePath) ? aggregatePath : undefined
	});
	planner.load().catch((err) => {
		console.error('Fatal: failed to load timetable/stops data.', err);
	});
	return planner;
}

export function getPlanner(): TransitPlanner {
	return (globalThis.__transitPlanner ??= createPlanner());
}
