/**
 * Turns the monthly Ist-Daten archives into per-station delay statistics.
 *
 * Scale is the whole problem here: twelve months are ~16 GB of zipped CSV that
 * expand to roughly 210 GB (one ~584 MB file per calendar day, ~2.4 M stop events
 * each). So the work is split in two:
 *
 *   1. Per day, the CSV is streamed straight out of the zip and each row reduced
 *      to (BPUIC, line, planned minute, day offset, delay) in a small zstd file.
 *      This is the pass that touches the bulk of the data, and it is why the
 *      parser below reads bytes rather than strings: nothing is decoded, split or
 *      allocated for the 12 of 21 columns that get thrown away.
 *   2. Per weekday, that weekday's ~52 sample files are aggregated into one row
 *      per scheduled service: sample count, average delay and the 10th percentile
 *      - the "how late can I still be" buffer the app shows. The same happens
 *      once more for each pool of weekdays (Mo-Fr, weekend, all), which the app
 *      offers as a broader basis for the same numbers.
 *
 * Both stages are resumable: a day whose sample file already exists is skipped,
 * and each sample file carries its own line texts so a partial run can still
 * rebuild the global line table.
 *
 * Delays are joined to the timetable by BPUIC, which the geops GTFS carries as the
 * `<bpuic>[:<platform>]` stop id prefix and the Ist-Daten always report. That
 * keeps the browser out of SLOID/DIDOK territory entirely - it just needs the
 * number in front of the colon.
 *
 * One wrinkle in that join: the Ist-Daten BPUIC column mixes 7-digit station
 * numbers (~500 k rows/day) with 9-digit platform codes that append a two-digit
 * platform to them (~2.1 M rows/day). Truncating to the leading seven digits
 * raises the number of stations that match the feed from ~4 k to ~24 k, of which
 * 99.3% are found in the GTFS - so the reading is safe, and station-level is the
 * granularity the lookup wants anyway.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import { holidayName } from '../src/lib/transit/holidays.ts';
import {
	BUCKETS,
	DAY_TYPES,
	DELAY_GROUPS,
	FORMAT_VERSION,
	I16_MAX,
	I16_MIN,
	ROW_SIZE,
	SAMPLES_DIR,
	daysFromCivil,
	ensureDir,
	isoDate,
	log,
	mb,
	num,
	timed
} from './layout.js';
import { openMember, readCentralDirectory } from './zip.js';

const MEMBER_RE = /(\d{4})-(\d{2})-(\d{2})[_-].*IstDaten.*\.csv$/i;

// The sample file: a self-describing struct-of-arrays blob, zstd'd whole.
//
//   u32 magic 'WSZS' | u16 version | u16 reserved | u32 rows | u32 dataOffset
//   u32 line count   | per line: u16 byte length + UTF-8 bytes | pad to 4
//   i32 bpuic[rows] | i32 delay[rows] | u16 line[rows] | u16 dep[rows] | i8 off[rows]
//
// The columns are ordered widest-first so every one of them lands on its natural
// alignment and the reader can view them in place instead of copying.
const SAMPLE_MAGIC = 0x535a5357; // "WSZS", little-endian
const SAMPLE_VERSION = 1;

// Field widths of the packed aggregation key: bpuic (24 bits) | line (12) |
// planned minute (11) | day offset (2), which is 49 bits and so still an exact
// float64 integer. See shard(), which refuses input that would overflow either.
const BPUIC_LIMIT = 1 << 24;
const LINE_LIMIT = 4096;

const SEMICOLON = 0x3b;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const QUOTE = 0x22;
const SPACE = 0x20;

// The nine columns this step needs, out of the feed's 21.
const COLUMNS = [
	'BETRIEBSTAG',
	'LINIEN_TEXT',
	'ZUSATZFAHRT_TF',
	'FAELLT_AUS_TF',
	'BPUIC',
	'ABFAHRTSZEIT',
	'AB_PROGNOSE',
	'AB_PROGNOSE_STATUS',
	'DURCHFAHRT_TF'
];

const UNBEKANNT = [...'unbekannt'].map((c) => c.charCodeAt(0));

/**
 * The bucket a service day belongs to: its weekday, or Sunday on a holiday.
 *
 * Public transport runs the Sunday timetable on nationwide holidays, so a
 * 1 August that falls on a Tuesday would otherwise poison Tuesday's statistics
 * with a completely different service pattern.
 */
export function dayTypeOf(date) {
	if (holidayName(date)) return 'sunday';
	return DAY_TYPES[(date.getDay() + 6) % 7];
}

// ------------------------------------------------------------------ stage 1

const digits2 = (b, i) => (b[i] - 48) * 10 + (b[i + 1] - 48);
const digits4 = (b, i) =>
	(b[i] - 48) * 1000 + (b[i + 1] - 48) * 100 + (b[i + 2] - 48) * 10 + (b[i + 3] - 48);

/** Case-insensitive comparison against "true", the feed's boolean spelling. */
const isTrue = (b, s, e) =>
	e - s === 4 &&
	(b[s] | 32) === 116 &&
	(b[s + 1] | 32) === 114 &&
	(b[s + 2] | 32) === 117 &&
	(b[s + 3] | 32) === 101;

function isUnbekannt(b, s, e) {
	if (e - s !== UNBEKANNT.length) return false;
	for (let i = 0; i < UNBEKANNT.length; i++) if ((b[s + i] | 32) !== UNBEKANNT[i]) return false;
	return true;
}

/**
 * Reduces one day's Ist-Daten CSV to the columns a departure board needs.
 *
 * Fed chunk by chunk from the zip so a 580 MB member never lands in memory, and
 * deliberately allocation-free per row: fields are (start, end) offsets into the
 * chunk, dates are parsed with integer arithmetic, and the only strings it ever
 * builds are the handful of distinct line texts.
 */
class SampleParser {
	constructor() {
		this.pending = Buffer.alloc(0);
		this.capacity = 2_500_000;
		this.rows = 0;
		this.bpuic = new Int32Array(this.capacity);
		this.delay = new Int32Array(this.capacity);
		this.line = new Uint16Array(this.capacity);
		this.dep = new Uint16Array(this.capacity);
		this.off = new Int8Array(this.capacity);
		this.lineTable = [];
		this.byPackedName = new Map(); // packed name bytes -> line index
		this.byName = new Map(); // fallback for names over 6 bytes
		this.fieldStart = new Int32Array(64);
		this.fieldEnd = new Int32Array(64);
		this.column = null;
		this.stamp = new Int32Array(2); // [day number, seconds of day]
	}

	/** "dd.mm.yyyy hh:mm[:ss]" into this.stamp; false when unparseable. */
	parseStamp(b, s, e) {
		const length = e - s;
		if (length < 16 || b[s + 2] !== 0x2e || b[s + 5] !== 0x2e) return false;
		this.stamp[0] = daysFromCivil(digits4(b, s + 6), digits2(b, s + 3), digits2(b, s));
		this.stamp[1] =
			digits2(b, s + 11) * 3600 + digits2(b, s + 14) * 60 + (length >= 19 ? digits2(b, s + 17) : 0);
		return true;
	}

	grow() {
		this.capacity *= 2;
		const wider = (source, Type) => {
			const next = new Type(this.capacity);
			next.set(source);
			return next;
		};
		this.bpuic = wider(this.bpuic, Int32Array);
		this.delay = wider(this.delay, Int32Array);
		this.line = wider(this.line, Uint16Array);
		this.dep = wider(this.dep, Uint16Array);
		this.off = wider(this.off, Int8Array);
	}

	push(chunk) {
		// `pending` is at most one unfinished row, so this copies the chunk once.
		const buffer = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
		let at = 0;
		for (;;) {
			const newline = buffer.indexOf(NEWLINE, at);
			if (newline < 0) break;
			const end = newline > at && buffer[newline - 1] === CARRIAGE_RETURN ? newline - 1 : newline;
			this.row(buffer, at, end);
			at = newline + 1;
		}
		this.pending = at < buffer.length ? Buffer.from(buffer.subarray(at)) : Buffer.alloc(0);
	}

	end() {
		if (this.pending.length) {
			this.row(this.pending, 0, this.pending.length);
			this.pending = Buffer.alloc(0);
		}
	}

	/** Splits one row into field offsets, then keeps it or drops it. */
	row(b, from, to) {
		const { fieldStart, fieldEnd } = this;
		let count = 0;
		let at = from;
		while (at <= to && count < fieldStart.length) {
			if (b[at] === QUOTE) {
				let j = at + 1;
				while (j < to && !(b[j] === QUOTE && (j + 1 >= to || b[j + 1] === SEMICOLON))) j++;
				fieldStart[count] = at + 1;
				fieldEnd[count] = j;
				at = j + 2;
			} else {
				let j = at;
				while (j < to && b[j] !== SEMICOLON) j++;
				fieldStart[count] = at;
				fieldEnd[count] = j;
				at = j + 1;
			}
			count++;
		}

		if (this.column === null) {
			this.readHeader(b, count);
			return;
		}
		const c = this.column;

		// Cancelled trips never left, pass-throughs don't let anyone board, and
		// extra trips aren't in the timetable this data is matched against.
		if (isTrue(b, fieldStart[c.cancelled], fieldEnd[c.cancelled])) return;
		if (isTrue(b, fieldStart[c.passing], fieldEnd[c.passing])) return;
		if (isTrue(b, fieldStart[c.extra], fieldEnd[c.extra])) return;

		const statusStart = fieldStart[c.status];
		const statusEnd = fieldEnd[c.status];
		if (statusEnd === statusStart || isUnbekannt(b, statusStart, statusEnd)) return;

		let lineStart = fieldStart[c.line];
		let lineEnd = fieldEnd[c.line];
		while (lineStart < lineEnd && b[lineStart] === SPACE) lineStart++;
		while (lineEnd > lineStart && b[lineEnd - 1] === SPACE) lineEnd--;
		if (lineEnd === lineStart) return;

		// Most rows report a 9-digit platform code (7-digit station + 2-digit
		// platform); the timetable side is station-level, so keep the head.
		const bpuicStart = fieldStart[c.bpuic];
		let bpuicEnd = fieldEnd[c.bpuic];
		if (bpuicEnd - bpuicStart > 7) bpuicEnd = bpuicStart + 7;
		let bpuic = 0;
		for (let i = bpuicStart; i < bpuicEnd; i++) {
			const digit = b[i] - 48;
			if (digit < 0 || digit > 9) return;
			bpuic = bpuic * 10 + digit;
		}
		if (bpuic <= 0) return;

		if (!this.parseStamp(b, fieldStart[c.planned], fieldEnd[c.planned])) return;
		const plannedDay = this.stamp[0];
		const plannedSecond = this.stamp[1];
		if (!this.parseStamp(b, fieldStart[c.actual], fieldEnd[c.actual])) return;
		// A handful of rows carry a nonsense AB_PROGNOSE (year 1900 and the like),
		// which is both meaningless and enough to overflow a narrower type.
		const delay =
			(this.stamp[0] - plannedDay) * 86400 + this.stamp[1] - plannedSecond;
		if (delay < -86400 || delay > 86400) return;

		const dayStart = fieldStart[c.serviceDay];
		if (
			fieldEnd[c.serviceDay] - dayStart < 10 ||
			b[dayStart + 2] !== 0x2e ||
			b[dayStart + 5] !== 0x2e
		) {
			return;
		}
		const offset =
			plannedDay -
			daysFromCivil(digits4(b, dayStart + 6), digits2(b, dayStart + 3), digits2(b, dayStart));
		if (offset < -1 || offset > 1) return;

		if (this.rows === this.capacity) this.grow();
		const at2 = this.rows;
		this.bpuic[at2] = bpuic;
		this.delay[at2] = delay;
		this.line[at2] = this.internLine(b, lineStart, lineEnd);
		this.dep[at2] = Math.trunc(plannedSecond / 60);
		this.off[at2] = offset;
		this.rows = at2 + 1;
	}

	readHeader(b, count) {
		const names = [];
		for (let i = 0; i < count; i++) {
			names.push(b.toString('utf8', this.fieldStart[i], this.fieldEnd[i]).replace(/^﻿/, '').trim());
		}
		const at = (name) => {
			const index = names.indexOf(name);
			if (index < 0) throw new Error(`Ist-Daten column ${name} is missing`);
			return index;
		};
		// Resolved by name, so a reordered or extended feed still works.
		this.column = {
			serviceDay: at(COLUMNS[0]),
			line: at(COLUMNS[1]),
			extra: at(COLUMNS[2]),
			cancelled: at(COLUMNS[3]),
			bpuic: at(COLUMNS[4]),
			planned: at(COLUMNS[5]),
			actual: at(COLUMNS[6]),
			status: at(COLUMNS[7]),
			passing: at(COLUMNS[8])
		};
	}

	/**
	 * The index of a line text in this day's table, adding it if new.
	 *
	 * Line texts are short and repeat millions of times, so the common case packs
	 * the bytes into a number and never builds a string at all.
	 */
	internLine(b, from, to) {
		if (to - from <= 6) {
			let packed = 0;
			for (let i = from; i < to; i++) packed = packed * 256 + b[i];
			let index = this.byPackedName.get(packed);
			if (index === undefined) {
				index = this.lineTable.length;
				this.lineTable.push(b.toString('utf8', from, to));
				this.byPackedName.set(packed, index);
			}
			return index;
		}
		const name = b.toString('utf8', from, to);
		let index = this.byName.get(name);
		if (index === undefined) {
			index = this.lineTable.length;
			this.lineTable.push(name);
			this.byName.set(name, index);
		}
		return index;
	}

	serialize() {
		const rows = this.rows;
		const names = this.lineTable.map((name) => Buffer.from(name, 'utf8'));
		const namesBytes = names.reduce((total, name) => total + 2 + name.length, 0);
		const headerEnd = 20 + namesBytes;
		const dataOffset = headerEnd + ((4 - (headerEnd % 4)) % 4);

		const out = Buffer.allocUnsafe(dataOffset + rows * 13);
		out.writeUInt32LE(SAMPLE_MAGIC, 0);
		out.writeUInt16LE(SAMPLE_VERSION, 4);
		out.writeUInt16LE(0, 6);
		out.writeUInt32LE(rows, 8);
		out.writeUInt32LE(dataOffset, 12);
		out.writeUInt32LE(names.length, 16);
		let at = 20;
		for (const name of names) {
			out.writeUInt16LE(name.length, at);
			at += 2;
			at += name.copy(out, at);
		}
		out.fill(0, at, dataOffset);

		const write = (array) => {
			const view = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
			at += view.copy(out, at);
		};
		at = dataOffset;
		write(this.bpuic.subarray(0, rows));
		write(this.delay.subarray(0, rows));
		write(this.line.subarray(0, rows));
		write(this.dep.subarray(0, rows));
		write(this.off.subarray(0, rows));
		return out;
	}
}

/** The (service day, zip entry) pairs of a monthly archive, in date order. */
function membersOf(archive) {
	const { entries } = readCentralDirectory(archive);
	const days = [];
	for (const entry of entries) {
		const match = MEMBER_RE.exec(entry.name);
		if (!match) continue;
		days.push({
			date: new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
			entry
		});
	}
	return days.sort((a, b) => a.date - b.date);
}

function sampleFile(dayType, day) {
	return path.join(SAMPLES_DIR, dayType, `${day}.bin.zst`);
}

/**
 * The days of an archive's month that earlier runs left in the samples directory,
 * each under the day type the calendar gives it now.
 */
function cachedDaysOf(archive) {
	const month = /(\d{4})-(\d{2})\.zip$/.exec(archive);
	if (!month) return [];
	const found = [];
	for (const dayType of DAY_TYPES) {
		const dir = path.join(SAMPLES_DIR, dayType);
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir)) {
			const day = /^(\d{4})-(\d{2})-(\d{2})\.bin\.zst$/.exec(name);
			if (!day || day[1] !== month[1] || day[2] !== month[2]) continue;
			const date = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
			if (dayTypeOf(date) === dayType) found.push({ dayType, day: isoDate(date) });
		}
	}
	return found.sort((a, b) => (a.day < b.day ? -1 : 1));
}

function openSampleFile(file) {
	let blob = zlib.zstdDecompressSync(fs.readFileSync(file));
	if (blob.readUInt32LE(0) !== SAMPLE_MAGIC) throw new Error(`${file}: not a sample file`);
	const version = blob.readUInt16LE(4);
	if (version !== SAMPLE_VERSION) {
		throw new Error(`${file}: sample format v${version}, expected v${SAMPLE_VERSION}`);
	}
	// The column views below need 4-byte alignment, which holds for a blob that
	// starts at 0. Only a pool-sized (tiny) result can start anywhere else.
	if (blob.byteOffset !== 0) blob = Buffer.from(blob);

	const names = [];
	let at = 20;
	for (let i = blob.readUInt32LE(16); i > 0; i--) {
		const length = blob.readUInt16LE(at);
		at += 2;
		names.push(blob.toString('utf8', at, at + length));
		at += length;
	}
	return { blob, names, rows: blob.readUInt32LE(8), dataOffset: blob.readUInt32LE(12) };
}

/** Reads only a sample file's line texts - enough to rebuild the global table. */
function readSampleLines(file) {
	return openSampleFile(file).names;
}

/** One sample file, as typed views onto the decompressed blob. */
function readSamples(file) {
	const { blob, names, rows, dataOffset } = openSampleFile(file);
	const view = (offset, Type, count) => new Type(blob.buffer, blob.byteOffset + offset, count);
	let column = dataOffset;
	const bpuic = view(column, Int32Array, rows);
	column += 4 * rows;
	const delay = view(column, Int32Array, rows);
	column += 4 * rows;
	const line = view(column, Uint16Array, rows);
	column += 2 * rows;
	const dep = view(column, Uint16Array, rows);
	column += 2 * rows;
	const off = view(column, Int8Array, rows);
	return { rows, names, bpuic, delay, line, dep, off };
}

/**
 * Reduces each day in each archive to a sample file.
 *
 * `fetch` is called with an archive that isn't on disk yet and returns whether it
 * could be downloaded; `prune` deletes each archive once its days are read.
 * Together they keep peak disk at one month rather than all twelve.
 *
 * @returns {Promise<{ days: Record<string, string[]>, lines: Set<string> }>}
 *   the service days covered per day type, and every line text seen
 */
export async function extract(
	archives,
	{ dayLimit = null, force = false, fetch = null, prune = false } = {}
) {
	const days = Object.fromEntries(DAY_TYPES.map((dayType) => [dayType, []]));
	const lines = new Set();
	let processed = 0;

	for (const archive of archives) {
		if (!fs.existsSync(archive) && !(fetch !== null && (await fetch(archive)))) {
			// Not published or not downloaded. The month is part of the window all
			// the same, so what an earlier run extracted from it still counts.
			const cached = cachedDaysOf(archive);
			log(
				`  ${path.basename(archive)}: not available - ` +
					(cached.length ? `using ${cached.length} service days extracted earlier` : 'skipping')
			);
			for (const { dayType, day } of cached) {
				if (dayLimit !== null && processed >= dayLimit) break;
				for (const name of readSampleLines(sampleFile(dayType, day))) lines.add(name);
				days[dayType].push(day);
				processed++;
			}
			continue;
		}
		const members = membersOf(archive);
		if (members.length === 0) {
			log(`  ${path.basename(archive)}: no IstDaten members found - skipping`);
			continue;
		}
		log(`  ${path.basename(archive)}: ${members.length} service days`);

		for (const { date, entry } of members) {
			if (dayLimit !== null && processed >= dayLimit) {
				log(`  stopping after ${processed} days (--days)`);
				return { days, lines };
			}
			const dayType = dayTypeOf(date);
			const file = sampleFile(dayType, isoDate(date));
			ensureDir(path.dirname(file));

			// A holiday moves between day types when the calendar changes, so drop
			// any copy of this day filed under a different one.
			for (const other of DAY_TYPES) {
				if (other === dayType) continue;
				const stale = sampleFile(other, isoDate(date));
				if (fs.existsSync(stale)) fs.unlinkSync(stale);
			}

			if (fs.existsSync(file) && !force) {
				for (const name of readSampleLines(file)) lines.add(name);
				days[dayType].push(isoDate(date));
				processed++;
				continue;
			}

			const parser = new SampleParser();
			await pipeline(
				openMember(archive, entry),
				new Writable({
					highWaterMark: 1 << 22,
					write(chunk, _encoding, done) {
						parser.push(chunk);
						done();
					}
				})
			);
			parser.end();

			fs.writeFileSync(file, zlib.zstdCompressSync(parser.serialize()));
			for (const name of parser.lineTable) lines.add(name);
			days[dayType].push(isoDate(date));
			processed++;

			const holiday = holidayName(date);
			log(
				`    ${isoDate(date)} ${dayType.padEnd(9)} ${num(parser.rows).padStart(10)} departures` +
					` -> ${mb(fs.statSync(file).size)}` +
					(holiday ? `   (${holiday}, counted as Sunday)` : '')
			);
		}

		if (prune) {
			// The `.fetched` stamp goes with it, or the next download would believe
			// the (now absent) archive is still up to date.
			const size = fs.statSync(archive).size;
			fs.unlinkSync(archive);
			fs.rmSync(`${archive}.fetched`, { force: true });
			log(`  ${path.basename(archive)}: removed, ${mb(size)} freed (--prune)`);
		}
	}
	return { days, lines };
}

// ------------------------------------------------------------------ stage 2

/**
 * An open-addressing map from integer keys to int32 values.
 *
 * The keys are packed (bpuic, line, minute, offset) tuples below 2^49, which a
 * Float64Array holds exactly - so this stays two flat allocations where a Map
 * would be tens of millions of boxed entries.
 */
class KeyMap {
	constructor(bits = 22) {
		this.mask = (1 << bits) - 1;
		this.keys = new Float64Array(this.mask + 1).fill(-1);
		this.values = new Int32Array(this.mask + 1);
		this.size = 0;
		this.limit = Math.trunc((this.mask + 1) * 0.6);
	}

	static hash(key) {
		const low = key >>> 0; // ToUint32 is key mod 2^32
		const high = Math.trunc(key / 4294967296);
		let h = Math.imul(low, 0x9e3779b1) ^ Math.imul(high + 1, 0x85ebca77);
		h ^= h >>> 15;
		h = Math.imul(h, 0x2545f491);
		return h ^ (h >>> 13);
	}

	grow() {
		const oldKeys = this.keys;
		const oldValues = this.values;
		this.mask = (this.mask + 1) * 2 - 1;
		this.keys = new Float64Array(this.mask + 1).fill(-1);
		this.values = new Int32Array(this.mask + 1);
		this.limit = Math.trunc((this.mask + 1) * 0.6);
		for (let i = 0; i < oldKeys.length; i++) {
			const key = oldKeys[i];
			if (key < 0) continue;
			let at = KeyMap.hash(key) & this.mask;
			while (this.keys[at] >= 0) at = (at + 1) & this.mask;
			this.keys[at] = key;
			this.values[at] = oldValues[i];
		}
	}

	/** The key's value, inserting `fresh` (and returning it) when absent. */
	intern(key, fresh) {
		let at = KeyMap.hash(key) & this.mask;
		for (;;) {
			const found = this.keys[at];
			if (found === key) return this.values[at];
			if (found < 0) {
				this.keys[at] = key;
				this.values[at] = fresh;
				if (++this.size > this.limit) this.grow();
				return fresh;
			}
			at = (at + 1) & this.mask;
		}
	}

	get(key) {
		let at = KeyMap.hash(key) & this.mask;
		for (;;) {
			const found = this.keys[at];
			if (found === key) return this.values[at];
			if (found < 0) return -1;
			at = (at + 1) & this.mask;
		}
	}

	set(key, value) {
		let at = KeyMap.hash(key) & this.mask;
		for (;;) {
			const found = this.keys[at];
			if (found === key) {
				this.values[at] = value;
				return;
			}
			if (found < 0) {
				this.keys[at] = key;
				this.values[at] = value;
				if (++this.size > this.limit) this.grow();
				return;
			}
			at = (at + 1) & this.mask;
		}
	}
}

/**
 * The k-th smallest of `pool[from..to)`, 0-indexed, by nearest rank.
 *
 * Hoare selection, which partitions in place - the pool is already a scratch copy
 * of one group's delays, and a group is at most a few dozen values.
 */
function kthSmallest(pool, from, to, k) {
	let left = from;
	let right = to - 1;
	const want = from + k;
	while (left < right) {
		const pivot = pool[(left + right) >> 1];
		let i = left;
		let j = right;
		while (i <= j) {
			while (pool[i] < pivot) i++;
			while (pool[j] > pivot) j--;
			if (i <= j) {
				const swap = pool[i];
				pool[i] = pool[j];
				pool[j] = swap;
				i++;
				j--;
			}
		}
		if (want <= j) right = j;
		else if (want >= i) left = i;
		else return pool[want];
	}
	return pool[want];
}

/** Rounds half away from zero, the way SQL's round() does. */
const roundHalfUp = (value) => (value < 0 ? -Math.round(-value) : Math.round(value));

/**
 * Aggregates one day type's (or one pool's) samples into one row per scheduled service.
 *
 * Runs in `chunks` passes over `bpuic % chunks`, which bounds peak memory no
 * matter how many months are in the samples: the exact percentile has to hold
 * every observation of a group at once, and a year of one weekday is ~117 M rows.
 * Re-reading the samples per pass costs about a second - far less than spilling.
 */
function aggregateDayType(files, lineIndex, allowed, maxBpuic, minSamples, chunks) {
	const out = {
		count: 0,
		capacity: 1 << 22,
		bpuic: null,
		line: null,
		dep: null,
		p10: null,
		avg: null,
		samples: null,
		off: null,
		// Samples of lines the line table doesn't have: skipped, and reported.
		ignoredRows: 0,
		ignoredLines: new Set()
	};
	out.bpuic = new Int32Array(out.capacity);
	out.line = new Uint16Array(out.capacity);
	out.dep = new Uint16Array(out.capacity);
	out.p10 = new Int32Array(out.capacity);
	out.avg = new Int32Array(out.capacity);
	out.samples = new Int32Array(out.capacity);
	out.off = new Int8Array(out.capacity);
	const growOut = () => {
		out.capacity *= 2;
		const wider = (source, Type) => {
			const next = new Type(out.capacity);
			next.set(source);
			return next;
		};
		out.bpuic = wider(out.bpuic, Int32Array);
		out.line = wider(out.line, Uint16Array);
		out.dep = wider(out.dep, Uint16Array);
		out.p10 = wider(out.p10, Int32Array);
		out.avg = wider(out.avg, Int32Array);
		out.samples = wider(out.samples, Int32Array);
		out.off = wider(out.off, Int8Array);
	};

	// Rows already written for a (bpuic, line, minute), so the day offsets of one
	// service collapse into the best-sampled one.
	const bestRow = new KeyMap(22);

	for (let chunk = 0; chunk < chunks; chunk++) {
		const groups = new KeyMap(22);
		let groupCount = 0;
		let groupCapacity = 1 << 22;
		let groupKey = new Float64Array(groupCapacity);
		let groupSize = new Int32Array(groupCapacity);
		let groupSum = new Float64Array(groupCapacity);

		let sampleCount = 0;
		let sampleCapacity = 1 << 24;
		let sampleGroup = new Int32Array(sampleCapacity);
		let sampleDelay = new Int32Array(sampleCapacity);

		for (const file of files) {
			const day = readSamples(file);
			const toGlobal = new Int32Array(day.names.length);
			for (let i = 0; i < day.names.length; i++) {
				const global = lineIndex.get(day.names[i]);
				if (global === undefined) out.ignoredLines.add(day.names[i]);
				toGlobal[i] = global ?? -1;
			}

			if (sampleCount + day.rows > sampleCapacity) {
				while (sampleCount + day.rows > sampleCapacity) sampleCapacity *= 2;
				const wider = (source) => {
					const next = new Int32Array(sampleCapacity);
					next.set(source);
					return next;
				};
				sampleGroup = wider(sampleGroup);
				sampleDelay = wider(sampleDelay);
			}

			for (let i = 0; i < day.rows; i++) {
				const bpuic = day.bpuic[i];
				if (bpuic % chunks !== chunk) continue;
				const line = toGlobal[day.line[i]];
				if (line < 0) {
					out.ignoredRows++;
					continue;
				}
				// bpuic (24 bits) | line (12) | minute (11) | offset (2) < 2^49
				const key = ((bpuic * 4096 + line) * 2048 + day.dep[i]) * 4 + (day.off[i] + 1);
				const group = groups.intern(key, groupCount);
				if (group === groupCount) {
					if (groupCount === groupCapacity) {
						groupCapacity *= 2;
						const widerKey = new Float64Array(groupCapacity);
						widerKey.set(groupKey);
						groupKey = widerKey;
						const widerSize = new Int32Array(groupCapacity);
						widerSize.set(groupSize);
						groupSize = widerSize;
						const widerSum = new Float64Array(groupCapacity);
						widerSum.set(groupSum);
						groupSum = widerSum;
					}
					groupKey[groupCount] = key;
					groupCount++;
				}
				groupSize[group]++;
				groupSum[group] += day.delay[i];
				sampleGroup[sampleCount] = group;
				sampleDelay[sampleCount] = day.delay[i];
				sampleCount++;
			}
		}

		// Lay the delays out group by group, so each percentile is a local select.
		const start = new Int32Array(groupCount + 1);
		for (let g = 0; g < groupCount; g++) start[g + 1] = start[g] + groupSize[g];
		const cursor = start.slice(0, groupCount);
		const pool = new Int32Array(sampleCount);
		for (let i = 0; i < sampleCount; i++) pool[cursor[sampleGroup[i]]++] = sampleDelay[i];

		for (let g = 0; g < groupCount; g++) {
			const key = groupKey[g];
			const off = (key % 4) - 1;
			const withoutOff = (key - (off + 1)) / 4;
			const dep = withoutOff % 2048;
			const withoutDep = (withoutOff - dep) / 2048;
			const line = withoutDep % 4096;
			const bpuic = (withoutDep - line) / 4096;
			const samples = groupSize[g];
			if (samples < minSamples) continue;
			if (bpuic > maxBpuic || allowed[bpuic] === 0) continue;

			// The catch buffer: the largest offset B such that the vehicle's delay
			// was >= B on at least 90% of observed days, so arriving B seconds after
			// the planned departure still catches it that often. That is the k-th
			// smallest delay with k = floor(n / 10), by nearest rank on the observed
			// values - deliberately not an interpolated percentile, which would
			// invent a buffer the data doesn't support once n < 10 (with delays
			// [-30, 150] it would claim -12 s, which holds on 1 of 2 days, not 90%).
			const p10 = kthSmallest(pool, start[g], start[g + 1], Math.trunc(samples / 10));
			const avg = roundHalfUp(groupSum[g] / samples);

			const serviceKey = (bpuic * 4096 + line) * 2048 + dep;
			const previous = bestRow.get(serviceKey);
			if (previous >= 0) {
				// Better sampled wins; on a tie the offset nearest the service day
				// does, which keeps the output independent of the read order.
				const better =
					samples > out.samples[previous] ||
					(samples === out.samples[previous] && Math.abs(off) < Math.abs(out.off[previous]));
				if (!better) continue;
				out.p10[previous] = p10;
				out.avg[previous] = avg;
				out.samples[previous] = samples;
				out.off[previous] = off;
				continue;
			}
			if (out.count === out.capacity) growOut();
			out.bpuic[out.count] = bpuic;
			out.line[out.count] = line;
			out.dep[out.count] = dep;
			out.p10[out.count] = p10;
			out.avg[out.count] = avg;
			out.samples[out.count] = samples;
			out.off[out.count] = off;
			bestRow.set(serviceKey, out.count);
			out.count++;
		}
	}
	return out;
}

/**
 * Writes one day type's shards: one file per `bpuic % BUCKETS`.
 *
 * Stations are ascending within a shard and a station's rows are sorted by
 * (line, minute), which is what lets the browser binary-search a station's block.
 */
function writeShards(out, dest) {
	const stationIndex = new Map();
	const stationIds = [];
	const stationRows = [];
	for (let i = 0; i < out.count; i++) {
		const bpuic = out.bpuic[i];
		let station = stationIndex.get(bpuic);
		if (station === undefined) {
			station = stationIds.length;
			stationIndex.set(bpuic, station);
			stationIds.push(bpuic);
			stationRows.push([]);
		}
		stationRows[station].push(i);
	}
	const sortKey = (row) => out.line[row] * 1440 + out.dep[row];
	for (const rows of stationRows) rows.sort((a, b) => sortKey(a) - sortKey(b));

	const buckets = Array.from({ length: BUCKETS }, () => []);
	for (const bpuic of Int32Array.from(stationIds).sort()) {
		buckets[bpuic % BUCKETS].push(stationIndex.get(bpuic));
	}

	ensureDir(dest);
	let files = 0;
	let bytes = 0;
	let clamped = 0;
	for (const [bucket, members] of buckets.entries()) {
		if (members.length === 0) continue;
		let rowCount = 0;
		for (const station of members) rowCount += stationRows[station].length;

		const blob = Buffer.allocUnsafe(5 + members.length * 12 + rowCount * ROW_SIZE);
		let at = 0;
		at = blob.writeUInt8(FORMAT_VERSION, at);
		at = blob.writeUInt32LE(members.length, at);
		let rowStart = 0;
		for (const station of members) {
			at = blob.writeUInt32LE(stationIds[station], at);
			at = blob.writeUInt32LE(rowStart, at);
			at = blob.writeUInt32LE(stationRows[station].length, at);
			rowStart += stationRows[station].length;
		}
		for (const station of members) {
			for (const row of stationRows[station]) {
				let p10 = out.p10[row];
				let avg = out.avg[row];
				if (p10 < I16_MIN || p10 > I16_MAX) {
					clamped++;
					p10 = Math.min(I16_MAX, Math.max(I16_MIN, p10));
				}
				if (avg < I16_MIN || avg > I16_MAX) {
					clamped++;
					avg = Math.min(I16_MAX, Math.max(I16_MIN, avg));
				}
				at = blob.writeUInt16LE(out.line[row], at);
				at = blob.writeUInt16LE(out.dep[row], at);
				at = blob.writeInt16LE(p10, at);
				at = blob.writeInt16LE(avg, at);
				at = blob.writeUInt8(Math.min(255, out.samples[row]), at);
				at = blob.writeInt8(out.off[row], at);
			}
		}
		const gzipped = zlib.gzipSync(blob, { level: 9 });
		fs.writeFileSync(path.join(dest, `${bucket}.bin.gz`), gzipped);
		files++;
		bytes += gzipped.length;
	}
	return { files, bytes, clamped, stations: stationIds };
}

/**
 * Aggregates the samples per day type and per DELAY_GROUPS pool, and writes the
 * gzipped delay shards.
 *
 * `days` is what extract() returned, and only those days' samples are read.
 *
 * @returns {Promise<{ dayTypes: string[], groups: string[], rows: number, files: number,
 *                     bytes: number, stations: number }>}
 */
export async function shard(
	outDir,
	{ lineTable, allowed, days, minSamples = 1, chunks = 4 }
) {
	const lineIndex = new Map(lineTable.map((line, index) => [line, index]));

	// The aggregation packs (bpuic, line, minute, offset) into one float64 key,
	// which is exact only while each field stays inside its bit width. Both bounds
	// hold by a wide margin today (~1.2 k lines, 7-digit BPUICs), but a silently
	// truncated key would corrupt statistics rather than fail, so check them.
	if (lineTable.length > LINE_LIMIT) {
		throw new Error(`${lineTable.length} lines exceeds the ${LINE_LIMIT} the key packing allows`);
	}

	// A bitmap beats a Set here: it is checked once per aggregated group.
	let maxBpuic = 0;
	for (const bpuic of allowed) if (bpuic > maxBpuic) maxBpuic = bpuic;
	if (maxBpuic >= BPUIC_LIMIT) {
		throw new Error(`BPUIC ${maxBpuic} exceeds the ${BPUIC_LIMIT} the key packing allows`);
	}
	const allowedBits = new Uint8Array(maxBpuic + 1);
	for (const bpuic of allowed) allowedBits[bpuic] = 1;

	// Written next to the live shards and swapped in once every day type is done:
	// a run that fails halfway has to leave the previous shards, which meta.json
	// still describes, rather than no shards at all.
	const delaysDir = path.join(outDir, 'delays');
	const buildDir = `${delaysDir}.next`;
	fs.rmSync(buildDir, { recursive: true, force: true });
	ensureDir(buildDir);
	const discard = (error) => {
		fs.rmSync(buildDir, { recursive: true, force: true });
		throw error;
	};

	const stations = new Set();
	const covered = [];
	const coveredGroups = [];
	let totalRows = 0;
	let totalFiles = 0;
	let totalBytes = 0;
	let totalClamped = 0;

	// The days this run extracted, not whatever the samples directory holds:
	// files of months that have since left the window stay on disk, and neither
	// their delays nor their lines belong in this build.
	const filesOf = (dayType) =>
		(days[dayType] ?? []).toSorted().map((day) => sampleFile(dayType, day));

	/** Aggregates `dayTypes`' samples into delays/<name>/; false when there are none. */
	const aggregate = async (name, dayTypes) => {
		const withSamples = dayTypes.filter((dayType) => filesOf(dayType).length > 0);
		const files = withSamples.flatMap(filesOf);
		if (files.length === 0) {
			log(`  ${name}: no samples - skipped`);
			return false;
		}
		// One pass per `chunks` per day type keeps each pass at the size of a
		// single weekday's, so a pool of seven costs time, not seven times the memory.
		const passes = chunks * withSamples.length;

		const written = await timed(`${name} aggregation`, async () => {
			const out = aggregateDayType(files, lineIndex, allowedBits, maxBpuic, minSamples, passes);
			const result = writeShards(out, path.join(buildDir, name));
			for (const bpuic of result.stations) stations.add(bpuic);
			return {
				rows: out.count,
				ignoredRows: out.ignoredRows,
				ignoredLines: out.ignoredLines,
				...result
			};
		}).catch(discard);

		totalRows += written.rows;
		totalFiles += written.files;
		totalBytes += written.bytes;
		totalClamped += written.clamped;
		log(`  ${name}: ${num(written.rows)} services, ${num(written.files)} shards, ${mb(written.bytes)}`);
		// A pool reads the same samples as its day types, which have reported these already.
		if (written.ignoredRows && dayTypes.length === 1) {
			log(
				`    ignored ${num(written.ignoredRows)} samples of lines not in the line table: ` +
					[...written.ignoredLines].slice(0, 10).join(', ')
			);
		}
		return true;
	};

	for (const dayType of DAY_TYPES) {
		if (await aggregate(dayType, [dayType])) covered.push(dayType);
	}
	for (const [group, dayTypes] of Object.entries(DELAY_GROUPS)) {
		if (await aggregate(group, dayTypes)) coveredGroups.push(group);
	}

	const oldDir = `${delaysDir}.old`;
	fs.rmSync(oldDir, { recursive: true, force: true });
	if (fs.existsSync(delaysDir)) fs.renameSync(delaysDir, oldDir);
	fs.renameSync(buildDir, delaysDir);
	fs.rmSync(oldDir, { recursive: true, force: true });

	if (totalClamped) {
		log(`  note: ${num(totalClamped)} outlier delay values clamped to +/-${I16_MAX} s`);
	}

	return {
		dayTypes: covered,
		groups: coveredGroups,
		rows: totalRows,
		files: totalFiles,
		bytes: totalBytes,
		stations: stations.size
	};
}
