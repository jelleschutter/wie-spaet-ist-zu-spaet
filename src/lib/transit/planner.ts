import { StopsIndex, Timetable } from 'minotor';
import type { Stop } from 'minotor';
import { fetchBinary, fetchJson } from './assets';
import { DelayIndex, type DelaysMeta, type StationDelays } from './delays';
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
// Runs entirely in the browser against the static data bundle in static/data/:
// this app only ever asks "what's the next departure from this station, and how
// late can I be for it?" - a single-stop departure-board lookup - never a
// RAPTOR A-to-B route, so there's no Router/Query here, just the Timetable's
// per-stop route index.
//
// Everything loads lazily and is then cached for the session: the stops index
// (~2.3 MB) on the first station search, a day type's timetable (~3-5 MB) on
// the first lookup for that day, and one ~15 KB delay shard per station.
// ---------------------------------------------------------------------------

/** An error with a message meant to be shown to the user as-is. */
export class TransitError extends Error {}

export type StaticMeta = {
	version: number;
	generatedAt: string;
	serviceDays: DayType[];
	delays: DelaysMeta;
	lines: string[];
};

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

export type DeparturesResult = {
	query: { from: StopDto; time: string; serviceDayType: DayType };
	availableServiceDays: DayType[];
	delaysAvailable: boolean;
	dayType: DayType | null;
	days: number | null;
	availableDayTypes: DayType[];
	nextDepartureTime: string | null;
	results: DepartureDto[];
};

type Candidate = {
	route: TimetableRoute;
	boardStopId: number;
	departureTime: number;
	serviceInfo: RouteServiceInfo;
};

export class TransitPlanner {
	private metaPromise?: Promise<StaticMeta>;
	private stopsPromise?: Promise<StopsIndex>;
	private timetablePromises = new Map<DayType, Promise<Timetable>>();
	private delaysPromise?: Promise<DelayIndex>;
	private stopsLoaded = false;
	private timetablesLoaded = new Set<DayType>();

	/** Whether a lookup for this day type can be answered without more downloads. */
	isReady(dayType: DayType): boolean {
		return this.stopsLoaded && this.timetablesLoaded.has(dayType);
	}

	/** Metadata of the static bundle: available service days, delay coverage, lines. */
	meta(): Promise<StaticMeta> {
		if (!this.metaPromise) {
			const promise = (this.metaPromise = fetchJson<StaticMeta>('meta.json'));
			promise.catch(() => {
				if (this.metaPromise === promise) this.metaPromise = undefined;
			});
		}
		return this.metaPromise;
	}

	private stops(): Promise<StopsIndex> {
		if (!this.stopsPromise) {
			const promise = (this.stopsPromise = fetchBinary('stops.bin.gz').then((data) => {
				const index = StopsIndex.fromData(data as Uint8Array);
				this.stopsLoaded = true;
				return index;
			}));
			promise.catch(() => {
				if (this.stopsPromise === promise) this.stopsPromise = undefined;
			});
		}
		return this.stopsPromise;
	}

	private timetable(dayType: DayType): Promise<Timetable> {
		const cached = this.timetablePromises.get(dayType);
		if (cached) return cached;
		const promise = fetchBinary(`timetable.${dayType}.bin.gz`).then((data) => {
			const timetable = Timetable.fromData(data as Uint8Array);
			this.timetablesLoaded.add(dayType);
			return timetable;
		});
		promise.catch(() => {
			if (this.timetablePromises.get(dayType) === promise) this.timetablePromises.delete(dayType);
		});
		this.timetablePromises.set(dayType, promise);
		return promise;
	}

	private delays(): Promise<DelayIndex> {
		if (!this.delaysPromise) {
			this.delaysPromise = this.meta().then((meta) => new DelayIndex(meta.delays, meta.lines));
			this.delaysPromise.catch(() => (this.delaysPromise = undefined));
		}
		return this.delaysPromise;
	}

	/**
	 * Starts fetching what the first interaction will need (metadata and the
	 * stops index), so typing into the station search doesn't wait for it.
	 */
	prewarm(): void {
		void this.meta().catch(() => {});
		void this.stops().catch(() => {});
	}

	/** The day type whose timetable is actually used for a requested one. */
	private resolveTimetableDayType(
		serviceDays: DayType[],
		requested: string | undefined | null
	): DayType | null {
		if (requested && serviceDays.includes(requested as DayType)) return requested as DayType;
		return serviceDays[0] ?? null;
	}

	// -------------------------------------------------------------------------
	// Stop search
	// -------------------------------------------------------------------------

	async searchStations({
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
	}): Promise<StopDto[]> {
		const stopsIndex = await this.stops();
		if (lat != null && lon != null) {
			// Generous default radius (unlike a map-style nearby search) since this
			// mainly backs a single "nearest station to me" lookup that should
			// still find something for someone standing a few km from any stop.
			return stopsIndex
				.findStopsByLocation(lat, lon, limit, radius ?? 5)
				.map((s) => this.stopDto(s));
		}
		if (!q) return [];
		// Over-fetch, then re-rank so exact/prefix matches beat substring hits.
		const pool = stopsIndex.findStopsByName(q, Math.max(limit, 25));
		return rankByName(pool, q)
			.slice(0, limit)
			.map((s) => this.stopDto(s));
	}

	/** Resolves a `from` argument: an internal numeric stop id, a GTFS source id, or a name. */
	private resolveStop(stopsIndex: StopsIndex, arg: string | null | undefined): Stop | undefined {
		if (arg == null || arg === '') return undefined;
		const str = String(arg).trim();
		if (/^\d+$/.test(str)) {
			const byId = stopsIndex.findStopById(Number(str));
			if (byId) return byId;
		}
		const bySource = stopsIndex.findStopBySourceStopId(str);
		if (bySource) return bySource;
		const candidates = stopsIndex.findStopsByName(str, 25);
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
	async getDepartures({
		from,
		time = '08:00',
		dayType
	}: {
		from: string | null;
		time?: string;
		dayType?: string | null;
	}): Promise<DeparturesResult> {
		if (!from) throw new TransitError('Bitte gib einen Abfahrtsort ein.');

		let afterMinutes: number;
		try {
			afterMinutes = hmToMinutes(time);
		} catch (e) {
			throw new TransitError((e as Error).message);
		}

		const [meta, stopsIndex] = await Promise.all([this.meta(), this.stops()]);
		const origin = this.resolveStop(stopsIndex, from);
		if (!origin) throw new TransitError(`Station "${from}" wurde nicht gefunden.`);

		const serviceDayType = this.resolveTimetableDayType(meta.serviceDays, dayType);
		if (!serviceDayType) throw new TransitError('Es sind keine Fahrplandaten vorhanden.');

		const delays = await this.delays();
		const useDayType = delays.resolveDayType(dayType);
		// Every board stop below is an equivalent stop of `origin`, so they all
		// share one BPUIC - a lookup never needs more than one delay shard.
		const station = origin.parent != null ? stopsIndex.findStopById(origin.parent) : undefined;
		const bpuic = bpuicOf(station ?? origin) ?? bpuicOf(origin);
		const [timetable, stationDelays] = await Promise.all([
			this.timetable(serviceDayType),
			useDayType && bpuic != null
				? delays.forStation(useDayType, bpuic)
				: Promise.resolve(null)
		]);

		const boardStopIds = new Set<number>([
			origin.id,
			...stopsIndex.equivalentStops(origin.id).map((s) => s.id)
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
		const delayMeta = {
			delaysAvailable: delays.dayTypes.length > 0,
			dayType: useDayType,
			days: useDayType ? delays.daysFor(useDayType) : null,
			availableDayTypes: delays.dayTypes
		};

		if (candidates.length === 0) {
			return {
				query,
				availableServiceDays: meta.serviceDays,
				...delayMeta,
				nextDepartureTime: null,
				results: []
			};
		}

		const earliest = Math.min(...candidates.map((c) => c.departureTime));
		const results = candidates
			.filter((c) => c.departureTime === earliest)
			.map((c) => this.departureDto(stopsIndex, c, stationDelays))
			.sort(
				(a, b) =>
					a.line.localeCompare(b.line) ||
					(a.destination?.name ?? '').localeCompare(b.destination?.name ?? '')
			);

		return {
			query,
			availableServiceDays: meta.serviceDays,
			...delayMeta,
			nextDepartureTime: minutesToClock(earliest),
			results
		};
	}

	private departureDto(
		stopsIndex: StopsIndex,
		{ route, boardStopId, departureTime, serviceInfo }: Candidate,
		stationDelays: StationDelays | null
	): DepartureDto {
		const boardStop = stopsIndex.findStopById(boardStopId)!;
		const destStop = stopsIndex.findStopById(route.stops[route.getNbStops() - 1]);

		const dto: DepartureDto = {
			line: serviceInfo.name,
			mode: ROUTE_TYPE_LABELS[serviceInfo.type as unknown as number] ?? 'OTHER',
			from: this.stopDto(boardStop),
			destination: destStop ? this.stopDto(destStop) : null,
			plannedDeparture: minutesToClock(departureTime),
			departure: eventTiming(departureTime, null)
		};

		const match = stationDelays?.match(serviceInfo.name, departureTime % (24 * 60));
		if (!match) return dto;
		dto.departure = eventTiming(departureTime, {
			delaySec: match.avg,
			catchBufferSec: match.catchBuffer,
			samples: match.samples,
			dayOffset: match.dayOffset
		});
		return dto;
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

/**
 * The BPUIC of a stop. Stop ids in the feed are `<bpuic>[:<platform>]`, and the
 * delay shards are keyed by that number (see delays.ts), so it is all the
 * browser needs to find a station's Ist-Daten.
 */
function bpuicOf(stop: Stop): number | null {
	const source = stop.sourceStopId;
	if (typeof source !== 'string') return null;
	const head = source.split(':', 1)[0];
	return /^\d+$/.test(head) ? Number(head) : null;
}

/** Builds the planned/actual/delay block for one boarding event. */
function eventTiming(
	plannedTime: number,
	info: {
		delaySec: number | null;
		catchBufferSec?: number | null;
		samples?: number | null;
		dayOffset?: number;
	} | null
): DepartureEventDto {
	const planned = minutesToClock(plannedTime);
	const dayOffset = info?.dayOffset ?? 0;
	const samples = info?.samples ?? null;
	const catchBufferSeconds = info?.catchBufferSec ?? null;
	if (!info || info.delaySec == null) {
		return {
			planned,
			dayOffset,
			actual: null,
			delaySeconds: null,
			delay: null,
			samples,
			catchBufferSeconds
		};
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
