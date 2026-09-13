/**
 * Just enough ZIP to read the upstream archives - the central directory (with the
 * ZIP64 records as a fallback) and one member as a stream - and to swap a single
 * member of the GTFS bundle.
 *
 * Node has no zip reader, but it has raw inflate, and that is all these two feeds
 * need: the GTFS bundle and every Ist-Daten archive store their members with
 * plain deflate. Streaming matters more than completeness here - a single
 * Ist-Daten member is ~580 MB of CSV and must never be held in memory at once.
 *
 * Not supported, because these feeds don't use it: encryption, multi-disk
 * archives, and compression methods other than store and deflate.
 */

import { once } from 'node:events';
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50; // end of central directory
const SIG_EOCD64 = 0x06064b50; // zip64 end of central directory
const SIG_LOCATOR64 = 0x07064b50; // zip64 locator, sits just before the EOCD
const SIG_CENTRAL = 0x02014b50; // central directory file header
const SIG_LOCAL = 0x04034b50; // local file header

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// The EOCD is at the very end, followed only by an optional comment of at most
// 64 KB - so it is somewhere in the last 65557 bytes and has to be searched for.
const EOCD_SEARCH = 65557;

/**
 * @typedef {{ name: string, method: number, compressed: number,
 *             uncompressed: number, offset: number }} ZipEntry
 */

/**
 * @returns {{ zip64: boolean, entries: ZipEntry[], directoryOffset: number,
 *             directorySize: number }}
 */
export function readCentralDirectory(file) {
	const fd = fs.openSync(file, 'r');
	try {
		const size = fs.fstatSync(fd).size;
		const tailLength = Math.min(size, EOCD_SEARCH);
		const tail = Buffer.allocUnsafe(tailLength);
		fs.readSync(fd, tail, 0, tailLength, size - tailLength);

		let at = -1;
		for (let i = tailLength - 22; i >= 0; i--) {
			if (tail.readUInt32LE(i) === SIG_EOCD) {
				at = i;
				break;
			}
		}
		if (at < 0) throw new Error(`${file}: no end-of-central-directory record`);

		let entryCount = tail.readUInt16LE(at + 10);
		let directorySize = tail.readUInt32LE(at + 12);
		let directoryOffset = tail.readUInt32LE(at + 16);
		let zip64 = false;

		// Any of the three saturating means the real values are in the ZIP64 record.
		if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
			const locatorAt = at - 20;
			if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== SIG_LOCATOR64) {
				throw new Error(`${file}: zip64 sizes but no zip64 locator`);
			}
			const eocd64Offset = Number(tail.readBigUInt64LE(locatorAt + 8));
			const head = Buffer.allocUnsafe(56);
			fs.readSync(fd, head, 0, 56, eocd64Offset);
			if (head.readUInt32LE(0) !== SIG_EOCD64) {
				throw new Error(`${file}: bad zip64 end-of-central-directory record`);
			}
			entryCount = Number(head.readBigUInt64LE(32));
			directorySize = Number(head.readBigUInt64LE(40));
			directoryOffset = Number(head.readBigUInt64LE(48));
			zip64 = true;
		}

		const directory = Buffer.allocUnsafe(directorySize);
		fs.readSync(fd, directory, 0, directorySize, directoryOffset);

		const entries = [];
		let o = 0;
		for (let i = 0; i < entryCount; i++) {
			if (directory.readUInt32LE(o) !== SIG_CENTRAL) {
				throw new Error(`${file}: bad central directory header for entry ${i}`);
			}
			const method = directory.readUInt16LE(o + 10);
			let compressed = directory.readUInt32LE(o + 20);
			let uncompressed = directory.readUInt32LE(o + 24);
			const nameLength = directory.readUInt16LE(o + 28);
			const extraLength = directory.readUInt16LE(o + 30);
			const commentLength = directory.readUInt16LE(o + 32);
			let offset = directory.readUInt32LE(o + 42);
			const name = directory.toString('utf8', o + 46, o + 46 + nameLength);

			// The ZIP64 extra field replaces whichever 32-bit fields saturated, in
			// this fixed order and only for those - so each is read conditionally.
			let extra = o + 46 + nameLength;
			const extraEnd = extra + extraLength;
			while (extra + 4 <= extraEnd) {
				const id = directory.readUInt16LE(extra);
				const length = directory.readUInt16LE(extra + 2);
				if (id === 0x0001) {
					let field = extra + 4;
					if (uncompressed === 0xffffffff) {
						uncompressed = Number(directory.readBigUInt64LE(field));
						field += 8;
					}
					if (compressed === 0xffffffff) {
						compressed = Number(directory.readBigUInt64LE(field));
						field += 8;
					}
					if (offset === 0xffffffff) offset = Number(directory.readBigUInt64LE(field));
				}
				extra += 4 + length;
			}

			entries.push({ name, method, compressed, uncompressed, offset });
			o = extraEnd + commentLength;
		}
		return { zip64, entries, directoryOffset, directorySize };
	} finally {
		fs.closeSync(fd);
	}
}

/** The entry named `name`, at the archive root or in any directory. */
export function findMember(entries, name) {
	return entries.find((entry) => entry.name === name || entry.name.endsWith(`/${name}`));
}

/**
 * A readable stream of one member's uncompressed bytes.
 *
 * The central directory's offset points at the member's *local* header, whose
 * name and extra fields have their own lengths - so where the data starts can
 * only be read from there.
 */
export function openMember(file, entry) {
	const fd = fs.openSync(file, 'r');
	const local = Buffer.allocUnsafe(30);
	try {
		fs.readSync(fd, local, 0, 30, entry.offset);
	} finally {
		fs.closeSync(fd);
	}
	if (local.readUInt32LE(0) !== SIG_LOCAL) {
		throw new Error(`${entry.name}: bad local file header`);
	}
	const dataStart = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);

	const raw = fs.createReadStream(file, {
		start: dataStart,
		end: dataStart + entry.compressed - 1,
		highWaterMark: 1 << 22
	});
	if (entry.method === METHOD_STORE) return raw;
	if (entry.method !== METHOD_DEFLATE) {
		throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
	}
	const inflate = zlib.createInflateRaw({ chunkSize: 1 << 22 });
	// .pipe() doesn't forward errors, and a read failure that only destroys the
	// file stream would leave the consumer waiting for data that never comes.
	raw.on('error', (error) => inflate.destroy(error));
	return raw.pipe(inflate);
}

/** One whole member in memory. Only for the small ones - see openMember. */
export async function readMember(file, entry) {
	const chunks = [];
	for await (const chunk of openMember(file, entry)) chunks.push(chunk);
	return Buffer.concat(chunks);
}

/**
 * Writes a copy of `source` to `dest` in which the member `name` holds `chunks`
 * (an async iterable of Buffers) instead, deflated.
 *
 * Every other member keeps its bytes and its offset: the copy is the source up
 * to its central directory, then the new member, then a central directory that
 * points at it. The old copy of the member stays behind unreferenced, which is
 * what spares re-deflating a 1.4 GB stop_times.txt to change a routes.txt.
 */
export async function replaceMember(source, dest, name, chunks) {
	const { zip64, entries, directoryOffset, directorySize } = readCentralDirectory(source);
	if (zip64) throw new Error(`${source}: rewriting a zip64 archive is not supported`);
	const entry = entries.find((candidate) => candidate.name === name);
	if (!entry) throw new Error(`${source}: no member ${name}`);

	const deflate = zlib.createDeflateRaw({ level: 9 });
	const parts = [];
	deflate.on('data', (part) => parts.push(part));
	const deflated = once(deflate, 'end');
	let crc = 0;
	let size = 0;
	for await (const chunk of chunks) {
		crc = zlib.crc32(chunk, crc);
		size += chunk.length;
		if (!deflate.write(chunk)) await once(deflate, 'drain');
	}
	deflate.end();
	await deflated;
	const data = Buffer.concat(parts);

	const directory = Buffer.allocUnsafe(directorySize);
	const sourceFd = fs.openSync(source, 'r');
	try {
		fs.readSync(sourceFd, directory, 0, directorySize, directoryOffset);
	} finally {
		fs.closeSync(sourceFd);
	}

	const records = [];
	let o = 0;
	for (let i = 0; i < entries.length; i++) {
		const nameLength = directory.readUInt16LE(o + 28);
		const end = o + 46 + nameLength + directory.readUInt16LE(o + 30) + directory.readUInt16LE(o + 32);
		if (entries[i] !== entry) {
			records.push(directory.subarray(o, end));
			o = end;
			continue;
		}
		const rawName = directory.subarray(o + 46, o + 46 + nameLength);
		// Same flags minus bit 3: sizes and CRC are in the headers, not after the data.
		const flags = directory.readUInt16LE(o + 8) & ~0x0008;
		const local = Buffer.alloc(30 + nameLength);
		local.writeUInt32LE(SIG_LOCAL, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(METHOD_DEFLATE, 8);
		directory.copy(local, 10, o + 12, o + 16); // modification time and date
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(size, 22);
		local.writeUInt16LE(nameLength, 26);
		rawName.copy(local, 30);

		const record = Buffer.alloc(46 + nameLength);
		directory.copy(record, 0, o, o + 46);
		record.writeUInt16LE(20, 6);
		record.writeUInt16LE(flags, 8);
		record.writeUInt16LE(METHOD_DEFLATE, 10);
		record.writeUInt32LE(crc, 16);
		record.writeUInt32LE(data.length, 20);
		record.writeUInt32LE(size, 24);
		record.writeUInt16LE(0, 30); // no extra field
		record.writeUInt16LE(0, 32); // no comment
		record.writeUInt32LE(directoryOffset, 42);
		rawName.copy(record, 46);
		records.push({ local, record });
		o = end;
	}

	const swapped = records.find((record) => !Buffer.isBuffer(record));
	const newDirectoryOffset = directoryOffset + swapped.local.length + data.length;
	const newDirectory = Buffer.concat(records.map((record) => (Buffer.isBuffer(record) ? record : record.record)));
	if (size > 0xffffffff || newDirectoryOffset + newDirectory.length > 0xffffffff) {
		throw new Error(`${dest}: would need zip64, which this writer doesn't do`);
	}
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(SIG_EOCD, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(newDirectory.length, 12);
	eocd.writeUInt32LE(newDirectoryOffset, 16);

	const part = `${dest}.part`;
	fs.copyFileSync(source, part);
	fs.truncateSync(part, directoryOffset);
	const fd = fs.openSync(part, 'r+');
	try {
		let at = directoryOffset;
		for (const buffer of [swapped.local, data, newDirectory, eocd]) {
			fs.writeSync(fd, buffer, 0, buffer.length, at);
			at += buffer.length;
		}
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(part, dest);
}
