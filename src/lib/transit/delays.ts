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

/**
 * The category of a line name that is one, or one plus a number: "RE" and
 * "RE12" are both "RE". Letters only, so bus "9" never passes for line "91".
 */
function categoryOf(name: string): string | undefined {
	return /^(\p{L}+)\d*$/u.exec(name)?.[1];
}

/** The global line table the shards' line indices point into. */
class LineTable {
	private names: string[];
	private ids: Map<string, number>;
	private numberedIds = new Map<string, number[]>();

	constructor(names: string[]) {
		this.names = names;
		this.ids = new Map(names.map((line, i) => [line, i]));
	}

	id(line: string): number | undefined {
		return this.ids.get(line);
	}

	name(id: number): string {
		return this.names[id];
	}

	/** The lines that add a number to a category: "RE" -> RE1, RE12, RE24, ... */
	numbered(category: string): number[] {
		let ids = this.numberedIds.get(category);
		if (!ids) {
			ids = [];
			for (let i = 0; i < this.names.length; i++) {
				const name = this.names[i];
				if (name.startsWith(category) && /^\d/.test(name.slice(category.length))) ids.push(i);
			}
			this.numberedIds.set(category, ids);
		}
		return ids;
	}
}

/** One station's delay rows for one day type. */
export class StationDelays {
	private lines: LineTable;
	private rows: DataView;
	private start: number;
	private count: number;

	constructor(lines: LineTable, rows: DataView, start: number, count: number) {
		this.lines = lines;
		this.rows = rows;
		this.start = start;
		this.count = count;
	}

	/**
	 * The delay statistics for a scheduled departure at its planned minute, or
	 * undefined when this service has no Ist-Daten. `taken` holds the line names
	 * of every departure the board has in that minute, this one's included.
	 *
	 * Rows are keyed by the Ist-Daten's line text, and the two feeds don't always
	 * name a train alike. The pipeline gives the timetable a line's full name
	 * where the GTFS feed has one ("RE12", from route_long_name "RE 12"), but the
	 * Ist-Daten call some trains by that name and others only by their category
	 * ("RE"), depending on the operator - and a timetable built before that knows
	 * only the category. So a departure is looked up by its own name first and by
	 * the other form after. Those second lookups only count when nothing else in
	 * the minute could own the row: a guess must never borrow another train's
	 * statistics.
	 */
	match(line: string, plannedDepMin: number, taken: ReadonlySet<string>): DepartureMatch | undefined {
		const name = line.trim();
		const exact = this.exact(name, plannedDepMin);
		if (exact) return exact;
		const category = categoryOf(name);
		if (category === undefined) return undefined;
		return category === name
			? this.byNumber(category, plannedDepMin, taken)
			: this.byCategory(name, category, plannedDepMin, taken);
	}

	private exact(name: string, plannedDepMin: number): DepartureMatch | undefined {
		const lineIdx = this.lines.id(name);
		if (lineIdx === undefined) return undefined;
		const row = this.find(lineIdx, plannedDepMin);
		return row < 0 ? undefined : this.rowAt(row);
	}

	/** "RE12" by the Ist-Daten's plain "RE" - when it is the only RE in the minute. */
	private byCategory(
		name: string,
		category: string,
		plannedDepMin: number,
		taken: ReadonlySet<string>
	): DepartureMatch | undefined {
		for (const other of taken) {
			if (other !== name && categoryOf(other) === category) return undefined;
		}
		return this.exact(category, plannedDepMin);
	}

	/**
	 * Plain "RE" by the Ist-Daten's "RE12" - when exactly one numbered RE leaves
	 * in the minute and no other departure goes by its name.
	 */
	private byNumber(
		category: string,
		plannedDepMin: number,
		taken: ReadonlySet<string>
	): DepartureMatch | undefined {
		let found = -1;
		for (const lineIdx of this.lines.numbered(category)) {
			if (taken.has(this.lines.name(lineIdx))) continue;
			const row = this.find(lineIdx, plannedDepMin);
			if (row < 0) continue;
			if (found >= 0) return undefined;
			found = row;
		}
		return found < 0 ? undefined : this.rowAt(found);
	}

	/** The row of a line at a planned minute, or -1; a station's rows are sorted by that key. */
	private find(lineIdx: number, plannedDepMin: number): number {
		const target = lineIdx * MINUTES_PER_DAY + plannedDepMin;
		let lo = this.start;
		let hi = this.start + this.count - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const key = this.keyAt(mid);
			if (key === target) return mid;
			if (key < target) lo = mid + 1;
			else hi = mid - 1;
		}
		return -1;
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
	private lines: LineTable;
	private shards = new Map<string, Promise<Shard | null>>();

	constructor(meta: DelaysMeta, lines: string[]) {
		this.meta = meta;
		this.lines = new LineTable(lines);
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
		return new StationDelays(this.lines, loaded.rows, entry.start, entry.count);
	}
}
