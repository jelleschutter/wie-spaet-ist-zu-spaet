/**
 * Just enough ZIP to read the upstream archives: the central directory (with the
 * ZIP64 records as a fallback) and one member as a stream.
 *
 * Node has no zip reader, but it has raw inflate, and that is all these two feeds
 * need: the GTFS bundle and every Ist-Daten archive store their members with
 * plain deflate. Streaming matters more than completeness here - a single
 * Ist-Daten member is ~580 MB of CSV and must never be held in memory at once.
 *
 * Not supported, because these feeds don't use it: encryption, multi-disk
 * archives, and compression methods other than store and deflate.
 */

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

/** @returns {{ zip64: boolean, entries: ZipEntry[] }} */
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
		return { zip64, entries };
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
