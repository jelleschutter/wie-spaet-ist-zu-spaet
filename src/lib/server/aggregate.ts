import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { DayType } from './time';

// ---------------------------------------------------------------------------
// Aggregated Ist-Daten index (average delays per scheduled service, by day type)
//
// Ported from transit-router's src/aggregate.js (departure-side only — this
// app never needs the arrival-side matching that /route used for A-to-B
// journeys, only "what's the next departure, and how late can I be for it?").
//
// A scheduled service at a stop is identified by (SLOID, line, planned
// departure) - stable day to day - so no trip id is stored. Matching is by
// line + planned time-of-day only.
//
// BPUIC fallback: some stops (notably regional buses) report a BPUIC but an
// empty SLOID in the Ist-Daten, so they have no SLOID to join on. Those rows
// are indexed separately by BPUIC (with the stop name for verification).
// ---------------------------------------------------------------------------

const DAY_TYPE_BY_CODE: Record<string, DayType> = { W: 'weekday', S: 'saturday', U: 'sunday' };

type AggEvent = {
	line: string;
	plannedDepMin: number | null;
	depAvg: number | null;
	depCatchBuffer: number | null;
	depSamples: number;
	depDayOffset: number;
	name?: string; // only set for SLOID-less (BPUIC-keyed) rows
};

export type DepartureMatch = {
	avg: number | null;
	catchBuffer: number | null;
	samples: number;
	dayOffset: number;
};

/** "HH:MM" -> minutes from midnight (0..1439), or null. */
function hmToMinutesOrNull(v: string | undefined): number | null {
	const s = (v ?? '').trim();
	if (!s) return null;
	const [h, m] = s.split(':');
	const hh = Number(h);
	const mm = Number(m);
	return Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : null;
}

/** Parses an integer cell, or the given fallback when empty/invalid. */
function toInt(v: string | undefined, fallback: number | null): number | null {
	const s = (v ?? '').trim();
	if (!s) return fallback;
	const n = Number(s);
	return Number.isFinite(n) ? n : fallback;
}

/** Line texts can carry incidental whitespace; compare loosely. */
function sameLine(a: string, b: string): boolean {
	return String(a).trim() === String(b).trim();
}

function normalizeName(s: string): string {
	return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Case/whitespace-insensitive stop-name equality; a missing name never matches. */
function nameMatches(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	return normalizeName(a) === normalizeName(b);
}

export class AggregateIndex {
	private byDayType: Map<DayType, Map<string, AggEvent[]>>;
	private byBpuic: Map<DayType, Map<string, AggEvent[]>>;
	private meta: Record<string, { days?: string[] }>;
	eventCount = 0;

	constructor(
		byDayType: Map<DayType, Map<string, AggEvent[]>>,
		byBpuic: Map<DayType, Map<string, AggEvent[]>>,
		meta: Record<string, { days?: string[] }>
	) {
		this.byDayType = byDayType;
		this.byBpuic = byBpuic;
		this.meta = meta ?? {};
		for (const map of [byDayType, this.byBpuic]) {
			for (const byKey of map.values()) {
				for (const events of byKey.values()) this.eventCount += events.length;
			}
		}
	}

	/** Day types that have data, e.g. ['weekday', 'saturday']. */
	get dayTypes(): DayType[] {
		return [...new Set([...this.byDayType.keys(), ...this.byBpuic.keys()])];
	}

	/** Number of days that contributed to a day type (from the meta sidecar). */
	daysFor(dayType: DayType): number {
		return this.meta[dayType]?.days?.length ?? 0;
	}

	/** Loads the aggregate CSV (+ its .meta.json sidecar) into memory. */
	static async load(
		csvPath: string,
		onProgress: (msg: string) => void = () => {}
	): Promise<AggregateIndex> {
		const metaPath = csvPath.replace(/\.csv$/, '.meta.json');
		let meta: Record<string, { days?: string[] }> = {};
		if (existsSync(metaPath)) {
			try {
				meta = JSON.parse(await readFile(metaPath, 'utf8'));
			} catch {
				/* meta is optional */
			}
		}

		const rl = createInterface({
			input: createReadStream(csvPath, { encoding: 'utf8' }),
			crlfDelay: Infinity
		});

		const byDayType = new Map<DayType, Map<string, AggEvent[]>>();
		const byBpuic = new Map<DayType, Map<string, AggEvent[]>>();
		const interned = new Map<string, string>();
		const intern = (s: string) => {
			const v = interned.get(s);
			if (v !== undefined) return v;
			interned.set(s, s);
			return s;
		};
		const bucket = (map: Map<DayType, Map<string, AggEvent[]>>, dayType: DayType, key: string) => {
			let byKey = map.get(dayType);
			if (!byKey) map.set(dayType, (byKey = new Map()));
			let arr = byKey.get(key);
			if (!arr) byKey.set(key, (arr = []));
			return arr;
		};

		let idx: Record<string, number> | null = null;
		let rowCount = 0;
		for await (const rawLine of rl) {
			if (rawLine === '') continue;
			if (idx === null) {
				const header = rawLine.replace(/^﻿/, '').split(';');
				const col = (n: string) => header.indexOf(n);
				idx = {
					dayType: col('DAYTYPE'),
					sloid: col('SLOID'),
					bpuic: col('BPUIC'), // -1 on legacy files without the column
					name: col('NAME'),
					line: col('LINIEN_TEXT'),
					depDay: col('AB_DAY'),
					plannedDep: col('ABFAHRTSZEIT'),
					depAvg: col('AB_DELAY_AVG'),
					depP10: col('AB_DELAY_P10'),
					depSamples: col('AB_SAMPLES')
				};
				continue;
			}

			const f = rawLine.split(';');
			const sloid = (f[idx.sloid] ?? '').trim();
			const bpuic = idx.bpuic >= 0 ? (f[idx.bpuic] ?? '').trim() : '';
			if (!sloid && !bpuic) continue;
			const rawDayType = (f[idx.dayType] ?? '').trim();
			const dayType = (DAY_TYPE_BY_CODE[rawDayType] ?? rawDayType) as DayType;

			const event: AggEvent = {
				line: intern((f[idx.line] ?? '').trim()),
				plannedDepMin: hmToMinutesOrNull(f[idx.plannedDep]),
				depAvg: toInt(f[idx.depAvg], null),
				// Catch buffer: latest arrival (seconds vs planned departure) that
				// still catches the vehicle on ~90% of days (10th percentile of dep delay).
				depCatchBuffer: idx.depP10 >= 0 ? toInt(f[idx.depP10], null) : null,
				depSamples: toInt(f[idx.depSamples], 0) ?? 0,
				depDayOffset: toInt(f[idx.depDay], 0) ?? 0
			};

			if (sloid) {
				bucket(byDayType, dayType, sloid).push(event);
			} else {
				// SLOID-less: keyed by BPUIC, with the name for match verification.
				event.name = intern(idx.name >= 0 ? (f[idx.name] ?? '').trim() : '');
				bucket(byBpuic, dayType, bpuic).push(event);
			}

			if (++rowCount % 500000 === 0) {
				onProgress(`  ...indexed ${rowCount.toLocaleString('en-US')} aggregate rows`);
			}
		}

		return new AggregateIndex(byDayType, byBpuic, meta);
	}

	/**
	 * Finds the average departure delay for a single boarding (no destination
	 * needed), matching on line + exact planned time-of-day: across the stop's
	 * equivalent SLOIDs first, then falling back to a BPUIC join (verified
	 * against the stop name) for SLOID-less rows.
	 */
	matchDeparture(
		dayType: DayType,
		{
			fromIds,
			fromBpuics,
			fromName,
			line,
			plannedDepMin
		}: {
			fromIds: string[];
			fromBpuics?: string[];
			fromName?: string;
			line: string;
			plannedDepMin: number;
		}
	): DepartureMatch | undefined {
		const bySloid = this.byDayType.get(dayType);
		const byBpuic = this.byBpuic.get(dayType);
		if (!bySloid && !byBpuic) return undefined;

		const gather = (map: Map<string, AggEvent[]> | undefined, ids: string[] | undefined) =>
			(ids ?? []).flatMap((id) => map?.get(id) ?? []);

		const depEvent =
			gather(bySloid, fromIds).find(
				(e) => sameLine(e.line, line) && e.plannedDepMin === plannedDepMin
			) ??
			gather(byBpuic, fromBpuics).find(
				(e) =>
					sameLine(e.line, line) &&
					e.plannedDepMin === plannedDepMin &&
					nameMatches(e.name, fromName)
			);

		if (!depEvent) return undefined;
		return {
			avg: depEvent.depAvg,
			catchBuffer: depEvent.depCatchBuffer,
			samples: depEvent.depSamples,
			dayOffset: depEvent.depDayOffset
		};
	}
}
