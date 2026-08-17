import { readFile } from 'node:fs/promises';
import { StopsIndex, Timetable } from 'minotor';
import type { Stop } from 'minotor';
import { AggregateIndex } from './aggregate';
import { formatDelay, hmToMinutes, minutesToClock, secondsToClock, type DayType } from './time';

// minotor's top-level package export re-exports a `Route`/`ServiceRouteInfo`
// pair from its *routing* module (journey legs), which shadows the
// differently-shaped pair its *timetable* module actually uses for
// `routesPassingThrough`/`getServiceRouteInfo` (route *patterns*, no
// RAPTOR routing here). Derive the real types from `Timetable`'s own method
// signatures instead of trusting the ambiguous top-level names.
type TimetableRoute = ReturnType<Timetable['routesPassingThrough']>[number];
type RouteServiceInfo = ReturnType<Timetable['getServiceRouteInfo']>;

// getServiceRouteInfo().type is minotor's internal numeric RouteTypes enum,
// not the human string ('RAIL', 'BUS', ...) - that stringification is only
// exposed on the *routing*-module's journey-leg API, which this app never
// calls (no RAPTOR routing here, just a per-stop departure board). Values
// confirmed against the installed minotor build's bundled RouteTypes object,
// since neither the enum nor its string-conversion helper is part of the
// package's public exports.
const ROUTE_TYPE_LABELS: Record<number, string> = {
	1: 'TRAM',
	2: 'SUBWAY',
	3: 'RAIL',
	4: 'BUS',
	5: 'FERRY',
	6: 'CABLE_TRAM',
	7: 'AERIAL_LIFT',
	8: 'FUNICULAR',
	9: 'TROLLEYBUS',
	10: 'MONORAIL'
};

// ---------------------------------------------------------------------------
// TransitPlanner
//
// Trimmed port of transit-router's src/planner.js: this app only ever asks
// "what's the next departure from this station, and how late can I be for
// it?" - a single-stop departure-board lookup - never a RAPTOR A-to-B route,
// so there's no Router/Query here, just the Timetable's per-stop route index.
// ---------------------------------------------------------------------------

export class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export type StopDto = {
	id: number;
	sourceStopId: string | null;
	name: string;
	platform: string | null;
	locationType: string;
	lat: number | null;
	lon: number | null;
};

export type DepartureEventDto = {
	planned: string;
	dayOffset: number;
	actual: string | null;
	delaySeconds: number | null;
	delay: string | null;
	samples: number | null;
	catchBufferSeconds: number | null;
};

export type DepartureDto = {
	line: string;
	mode: string;
	from: StopDto;
	destination: StopDto | null;
	plannedDeparture: string;
	departure: DepartureEventDto;
};

type Candidate = {
	route: TimetableRoute;
	boardStopId: number;
	departureTime: number;
	serviceInfo: RouteServiceInfo;
};

export class TransitPlanner {
	private timetables: Partial<Record<DayType, Timetable>> = {};
	private stopsIndex!: StopsIndex;
	private sloidToDidok = new Map<string, string>();
	private aggregate: AggregateIndex | null = null;

	stopsReady = false;
	delaysReady = false;
	delaysError: Error | null = null;

	constructor(
		private paths: {
			timetablePaths: Partial<Record<DayType, string>>;
			stopsPath: string;
			didokPath?: string;
			aggregatePath?: string;
		}
	) {}

	isReady(): boolean {
		return this.stopsReady;
	}

	/** Loads the timetables and stops index (fast), then the delay index in the background. */
	async load(log: (msg: string) => void = console.log): Promise<void> {
		log('Loading timetables and stops index...');
		this.stopsIndex = StopsIndex.fromData(await readFile(this.paths.stopsPath));

		for (const [dayType, path] of Object.entries(this.paths.timetablePaths) as [DayType, string][]) {
			this.timetables[dayType] = Timetable.fromData(await readFile(path));
		}
		if (this.timetableDayTypes.length === 0) {
			throw new Error('No timetable files were configured.');
		}

		await this.loadDidokMap(log);

		this.stopsReady = true;
		log(
			`Stops index ready (${this.stopsIndex.size().toLocaleString('en-US')} stops). ` +
				`Timetables: ${this.timetableDayTypes.join(', ')}.`
		);

		this.loadDelays(log);
	}

	private async loadDidokMap(log: (msg: string) => void) {
		const path = this.paths.didokPath;
		if (!path) return;
		let text: string;
		try {
			text = await readFile(path, 'utf8');
		} catch {
			return;
		}
		let first = true;
		for (const line of text.split('\n')) {
			if (!line) continue;
			if (first) {
				first = false; // skip the "sloid,didok" header
				continue;
			}
			const comma = line.indexOf(',');
			if (comma < 0) continue;
			const sloid = line.slice(0, comma).trim();
			const didok = line.slice(comma + 1).trim();
			if (sloid && didok) this.sloidToDidok.set(sloid, didok);
		}
		log(`DIDOK map ready (${this.sloidToDidok.size.toLocaleString('en-US')} stops).`);
	}

	private async loadDelays(log: (msg: string) => void) {
		if (!this.paths.aggregatePath) return;
		try {
			const t0 = Date.now();
			log('Indexing aggregated delays (averages by day type) in the background...');
			this.aggregate = await AggregateIndex.load(this.paths.aggregatePath, log);
			const summary = this.aggregate.dayTypes
				.map((t) => `${t} (${this.aggregate!.daysFor(t)}d)`)
				.join(', ');
			this.delaysReady = true;
			const secs = ((Date.now() - t0) / 1000).toFixed(1);
			log(
				`Average delays ready: ${summary}; ` +
					`${this.aggregate.eventCount.toLocaleString('en-US')} service rows (${secs}s).`
			);
		} catch (err) {
			this.delaysError = err as Error;
			log(`Failed to index delays: ${(err as Error).message}`);
		}
	}

	/** Day types that have a loaded timetable, e.g. ['weekday', 'saturday']. */
	get timetableDayTypes(): DayType[] {
		return Object.keys(this.timetables) as DayType[];
	}

	/** Day types that have aggregated delay data, e.g. ['weekday', 'saturday']. */
	get dayTypes(): DayType[] {
		return this.aggregate?.dayTypes ?? [];
	}

	get delaysMeta() {
		return {
			ready: this.delaysReady,
			dayTypes: this.dayTypes,
			days: Object.fromEntries(this.dayTypes.map((t) => [t, this.aggregate?.daysFor(t) ?? 0])),
			error: this.delaysError?.message ?? null
		};
	}

	/** The day type whose timetable is actually used for a requested one. */
	private resolveTimetableDayType(requested: string | undefined): DayType | null {
		const want = (requested || 'weekday') as DayType;
		if (this.timetables[want]) return want;
		if (this.timetables.weekday) return 'weekday';
		return this.timetableDayTypes[0] ?? null;
	}

	/** Resolves a requested day type to one that has aggregate data (default: weekday). */
	private resolveDayType(requested: string | undefined): DayType | null {
		const types = this.dayTypes;
		if (types.length === 0) return null;
		if (requested && types.includes(requested as DayType)) return requested as DayType;
		return types.includes('weekday') ? 'weekday' : types[0];
	}

	// -------------------------------------------------------------------------
	// Stop search
	// -------------------------------------------------------------------------

	searchStations({
		q,
		lat,
		lon,
		radius,
		limit = 10
	}: {
		q?: string;
		lat?: number;
		lon?: number;
		radius?: number;
		limit?: number;
	}): StopDto[] {
		if (lat != null && lon != null) {
			// Generous default radius (unlike a map-style nearby search) since this
			// mainly backs a single "nearest station to me" lookup that should
			// still find something for someone standing a few km from any stop.
			return this.stopsIndex
				.findStopsByLocation(lat, lon, limit, radius ?? 5)
				.map((s) => this.stopDto(s));
		}
		if (!q) return [];
		// Over-fetch, then re-rank so exact/prefix matches beat substring hits.
		const pool = this.stopsIndex.findStopsByName(q, Math.max(limit, 25));
		return rankByName(pool, q)
			.slice(0, limit)
			.map((s) => this.stopDto(s));
	}

	/** Resolves a `from` argument: an internal numeric stop id, a GTFS source id, or a name. */
	private resolveStop(arg: string | null | undefined): Stop | undefined {
		if (arg == null || arg === '') return undefined;
		const str = String(arg).trim();
		if (/^\d+$/.test(str)) {
			const byId = this.stopsIndex.findStopById(Number(str));
			if (byId) return byId;
		}
		const bySource = this.stopsIndex.findStopBySourceStopId(str);
		if (bySource) return bySource;
		const candidates = this.stopsIndex.findStopsByName(str, 25);
		return rankByName(candidates, str)[0];
	}

	// -------------------------------------------------------------------------
	// Departure board
	// -------------------------------------------------------------------------

	/**
	 * Finds the next departure(s) from a single station - no destination - and,
	 * when available, how late you can arrive and still catch it ~90% of the
	 * time. Looks across the station's platforms/equivalent stops, since a
	 * timetable spreads departures across child stop ids. When several
	 * services are tied for the earliest departure minute, all are returned.
	 */
	getDepartures({
		from,
		time = '08:00',
		dayType
	}: {
		from: string | null;
		time?: string;
		dayType?: string | null;
	}) {
		if (!from) throw new HttpError(400, 'Bitte gib einen Abfahrtsort ein.');
		const origin = this.resolveStop(from);
		if (!origin) throw new HttpError(404, `Station "${from}" wurde nicht gefunden.`);

		let afterMinutes: number;
		try {
			afterMinutes = hmToMinutes(time);
		} catch (e) {
			throw new HttpError(400, (e as Error).message);
		}

		const serviceDayType = this.resolveTimetableDayType(dayType ?? undefined);
		const timetable = serviceDayType ? this.timetables[serviceDayType] : null;
		if (!timetable) throw new HttpError(503, 'Der Fahrplan wird noch geladen.');
		const useDayType = this.resolveDayType(dayType ?? undefined);

		const boardStopIds = new Set<number>([
			origin.id,
			...this.stopsIndex.equivalentStops(origin.id).map((s) => s.id)
		]);

		const candidates: Candidate[] = [];
		const seen = new Set<string>();
		for (const boardStopId of boardStopIds) {
			for (const route of timetable.routesPassingThrough(boardStopId)) {
				for (const stopIndex of route.stopRouteIndices(boardStopId)) {
					// The pattern's last stop is where the vehicle terminates - there's
					// no onward journey to board there, so it's not a real departure
					// (and its destination would misleadingly be this same station).
					if (stopIndex === route.getNbStops() - 1) continue;
					const tripIndex = route.findEarliestTrip(stopIndex, afterMinutes);
					if (tripIndex === undefined) continue;
					const key = `${route.id}:${tripIndex}:${stopIndex}`;
					if (seen.has(key)) continue;
					seen.add(key);
					candidates.push({
						route,
						boardStopId,
						departureTime: route.departureFrom(stopIndex, tripIndex),
						serviceInfo: timetable.getServiceRouteInfo(route)
					});
				}
			}
		}

		const query = {
			from: this.stopDto(origin),
			time: minutesToClock(afterMinutes),
			serviceDayType
		};

		if (candidates.length === 0) {
			return {
				query,
				availableServiceDays: this.timetableDayTypes,
				...this.delayMeta(useDayType),
				nextDepartureTime: null,
				results: [] as DepartureDto[]
			};
		}

		const earliest = Math.min(...candidates.map((c) => c.departureTime));
		const results = candidates
			.filter((c) => c.departureTime === earliest)
			.map((c) => this.departureDto(c, useDayType))
			.sort(
				(a, b) =>
					a.line.localeCompare(b.line) ||
					(a.destination?.name ?? '').localeCompare(b.destination?.name ?? '')
			);

		return {
			query,
			availableServiceDays: this.timetableDayTypes,
			...this.delayMeta(useDayType),
			nextDepartureTime: minutesToClock(earliest),
			results
		};
	}

	private departureDto({ route, boardStopId, departureTime, serviceInfo }: Candidate, dayType: DayType | null): DepartureDto {
		const boardStop = this.stopsIndex.findStopById(boardStopId)!;
		const destStop = this.stopsIndex.findStopById(route.stops[route.getNbStops() - 1]);

		const dto: DepartureDto = {
			line: serviceInfo.name,
			mode: ROUTE_TYPE_LABELS[serviceInfo.type as unknown as number] ?? 'OTHER',
			from: this.stopDto(boardStop),
			destination: destStop ? this.stopDto(destStop) : null,
			plannedDeparture: minutesToClock(departureTime),
			departure: eventTiming(departureTime, null)
		};

		if (!this.delaysReady || !this.aggregate || !dayType) return dto;

		const match = this.aggregate.matchDeparture(dayType, {
			fromIds: this.equivalentSloids(boardStop),
			fromBpuics: this.bpuicsFor(boardStop),
			fromName: boardStop.name,
			line: serviceInfo.name,
			plannedDepMin: departureTime % (24 * 60)
		});
		if (!match) return dto;
		dto.departure = eventTiming(departureTime, {
			delaySec: match.avg,
			catchBufferSec: match.catchBuffer,
			samples: match.samples,
			dayOffset: match.dayOffset
		});
		return dto;
	}

	/** Top-level delay context for a response (which day type, coverage). */
	private delayMeta(dayType: DayType | null) {
		return {
			delaysAvailable: this.delaysReady,
			dayType: dayType,
			days: dayType ? (this.aggregate?.daysFor(dayType) ?? 0) : null,
			availableDayTypes: this.dayTypes
		};
	}

	/**
	 * All SLOIDs equivalent to a stop: itself, sibling platforms, and the
	 * platform-less station entry (bare `ch:1:sloid:<number>`), since Ist-Daten
	 * reports some modes at platform level and others at station level.
	 */
	private equivalentSloids(stop: Stop): string[] {
		const ids = new Set<string>();
		for (const s of this.stopsIndex.equivalentStops(stop.id)) {
			const id = s.sourceStopId;
			if (typeof id !== 'string') continue;
			ids.add(id);
			const m = id.match(/^(ch:1:sloid:\d+)(?:[:_].*)?$/);
			if (m) ids.add(m[1]);
		}
		return [...ids];
	}

	/** The BPUIC(s) of a stop, resolved from the sloid->didok sidecar. */
	private bpuicsFor(stop: Stop): string[] {
		if (this.sloidToDidok.size === 0) return [];
		const out = new Set<string>();
		for (const sloid of this.equivalentSloids(stop)) {
			const didok = this.sloidToDidok.get(sloid);
			if (didok) out.add(didok);
		}
		return [...out];
	}

	private stopDto(stop: Stop): StopDto {
		return {
			id: stop.id,
			sourceStopId: stop.sourceStopId ?? null,
			name: stop.name,
			platform: stop.platform ?? null,
			locationType: stop.locationType,
			lat: stop.lat ?? null,
			lon: stop.lon ?? null
		};
	}
}

/** Builds the planned/actual/delay block for one boarding event. */
function eventTiming(
	plannedTime: number,
	info: { delaySec: number | null; catchBufferSec?: number | null; samples?: number | null; dayOffset?: number } | null
): DepartureEventDto {
	const planned = minutesToClock(plannedTime);
	const dayOffset = info?.dayOffset ?? 0;
	const samples = info?.samples ?? null;
	const catchBufferSeconds = info?.catchBufferSec ?? null;
	if (!info || info.delaySec == null) {
		return { planned, dayOffset, actual: null, delaySeconds: null, delay: null, samples, catchBufferSeconds };
	}
	const actualSeconds = (plannedTime % (24 * 60)) * 60 + info.delaySec;
	return {
		planned,
		dayOffset,
		actual: secondsToClock(actualSeconds),
		delaySeconds: info.delaySec,
		delay: formatDelay(info.delaySec),
		samples,
		catchBufferSeconds
	};
}

/**
 * Re-ranks name-search results so better matches come first, using minotor's
 * own relevance order only as a stable tiebreaker within each tier.
 */
function rankByName(stops: Stop[], query: string): Stop[] {
	const q = query.trim().toLowerCase();
	const wordPrefix = new RegExp(`(^|[\\s,/-])${escapeRegExp(q)}`);
	const tier = (name: string) => {
		const n = name.toLowerCase();
		if (n === q) return 0;
		if (n.startsWith(q)) return 1;
		if (wordPrefix.test(n)) return 2;
		return 3;
	};
	return stops
		.map((s, i) => ({ s, i, t: tier(s.name) }))
		.sort((a, b) => a.t - b.t || a.i - b.i)
		.map((x) => x.s);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
