import { fetchBinary } from './assets';
import type { DayType } from './time';

// ---------------------------------------------------------------------------
// Aggregated Ist-Daten index (delay statistics per scheduled service, by weekday)
//
// The pipeline (pipeline/delays.py) reduces a year of Ist-Daten to binary
// shards, one per (weekday, station bucket). A scheduled service at a station is
// identified by (line, planned departure minute) - stable week to week - so no
// trip id is stored, and matching is by line + planned time only.
//
// Stations are keyed by BPUIC, which is both the prefix of every GTFS stop id
// (`<bpuic>[:<platform>]`) and a column of the Ist-Daten. So the join happens at
// build time and a lookup here needs nothing but the number in front of the
// colon - and exactly one ~20 KB shard.
//
// Shard layout (little-endian), see pipeline/delays.py for the writer:
//
//   u8    format version
//   u32   station count
//   n x   { u32 BPUIC, u32 first row, u32 row count }   sorted by BPUIC
//   rows  { u16 line index, u16 planned departure minute,
//           i16 catch buffer s, i16 average delay s,
//           u8 samples, i8 day offset }
//
// Rows are sorted by (line index, planned minute) and deduplicated, so a
// station's block can be binary-searched for an exact match.
// ---------------------------------------------------------------------------

const FORMAT_VERSION = 2;
const ROW_SIZE = 10;
const MINUTES_PER_DAY = 1440;

export type DelaysMeta = {
	dayTypes: DayType[];
	days: Partial<Record<DayType, number>>;
	buckets: number;
	stations: number;
};

export type DepartureMatch = {
	avg: number;
	catchBuffer: number;
	samples: number;
	dayOffset: number;
};

type Shard = {
	stations: Map<number, { start: number; count: number }>;
	rows: DataView;
};

function parseShard(data: Uint8Array | null): Shard | null {
	if (!data || data.length < 5) return null;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const version = view.getUint8(0);
	if (version !== FORMAT_VERSION) {
		throw new Error(`Unbekannte Version der Verspätungsdaten (${version}).`);
	}
	const count = view.getUint32(1, true);
	const stations = new Map<number, { start: number; count: number }>();
	let offset = 5;
	for (let i = 0; i < count; i++) {
		stations.set(view.getUint32(offset, true), {
			start: view.getUint32(offset + 4, true),
			count: view.getUint32(offset + 8, true)
		});
		offset += 12;
	}
	return {
		stations,
		rows: new DataView(data.buffer, data.byteOffset + offset, data.byteLength - offset)
	};
}

/** One station's delay rows for one day type. */
export class StationDelays {
	private lineIds: Map<string, number>;
	private rows: DataView;
	private start: number;
	private count: number;

	constructor(lineIds: Map<string, number>, rows: DataView, start: number, count: number) {
		this.lineIds = lineIds;
		this.rows = rows;
		this.start = start;
		this.count = count;
	}

	/**
	 * The delay statistics for a scheduled departure, matched on line + exact
	 * planned time-of-day, or undefined when this service has no Ist-Daten.
	 */
	match(line: string, plannedDepMin: number): DepartureMatch | undefined {
		const lineIdx = this.lineIds.get(line.trim());
		if (lineIdx === undefined) return undefined;
		const target = lineIdx * MINUTES_PER_DAY + plannedDepMin;

		let lo = this.start;
		let hi = this.start + this.count - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const key = this.keyAt(mid);
			if (key === target) return this.rowAt(mid);
			if (key < target) lo = mid + 1;
			else hi = mid - 1;
		}
		return undefined;
	}

	private keyAt(row: number): number {
		const at = row * ROW_SIZE;
		return this.rows.getUint16(at, true) * MINUTES_PER_DAY + this.rows.getUint16(at + 2, true);
	}

	private rowAt(row: number): DepartureMatch {
		const at = row * ROW_SIZE;
		return {
			catchBuffer: this.rows.getInt16(at + 4, true),
			avg: this.rows.getInt16(at + 6, true),
			samples: this.rows.getUint8(at + 8),
			dayOffset: this.rows.getInt8(at + 9)
		};
	}
}

export class DelayIndex {
	private meta: DelaysMeta;
	private lineIds: Map<string, number>;
	private shards = new Map<string, Promise<Shard | null>>();

	constructor(meta: DelaysMeta, lines: string[]) {
		this.meta = meta;
		this.lineIds = new Map(lines.map((line, i) => [line, i]));
	}

	/** Day types that have aggregated delay data, e.g. ['weekday', 'saturday']. */
	get dayTypes(): DayType[] {
		return this.meta.dayTypes;
	}

	/** Number of days that contributed to a day type. */
	daysFor(dayType: DayType): number {
		return this.meta.days[dayType] ?? 0;
	}

	/** Resolves a requested day type to one that has data. */
	resolveDayType(requested: string | undefined | null): DayType | null {
		const types = this.dayTypes;
		if (types.length === 0) return null;
		if (requested && types.includes(requested as DayType)) return requested as DayType;
		return types[0];
	}

	/** Loads (and caches) the delay rows of one station (by BPUIC) for one day type. */
	async forStation(dayType: DayType, bpuic: number): Promise<StationDelays | null> {
		if (!this.dayTypes.includes(dayType)) return null;
		const path = `delays/${dayType}/${bpuic % this.meta.buckets}.bin.gz`;
		let shard = this.shards.get(path);
		if (!shard) {
			shard = fetchBinary(path, { optional: true }).then(parseShard);
			// A failed shard must not poison the cache - the next lookup retries.
			shard.catch(() => this.shards.delete(path));
			this.shards.set(path, shard);
		}
		const loaded = await shard;
		const entry = loaded?.stations.get(bpuic);
		if (!loaded || !entry) return null;
		return new StationDelays(this.lineIds, loaded.rows, entry.start, entry.count);
	}
}
