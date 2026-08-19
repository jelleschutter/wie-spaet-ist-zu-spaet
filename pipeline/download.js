/**
 * Downloads the upstream feeds: the GTFS timetable and the monthly Ist-Daten.
 *
 * Both sources are large (GTFS ~165 MB, each Ist-Daten month ~1.3 GB), so
 * downloads are resumable and skipped when the local copy already matches the
 * remote size and Last-Modified. The GTFS feed is rebuilt daily, so its
 * Last-Modified moves even when the content doesn't and it is re-fetched once a
 * day - which is also what keeps the timetable step honest about re-parsing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';

import { GTFS_ZIP, ISTDATEN_DIR, ensureDir, log, mb } from './layout.js';

const GTFS_URL = 'https://gtfs.geops.ch/dl/gtfs_complete.zip';
const ISTDATEN_URL =
	'https://archive.opentransportdata.swiss/istdaten/{year}/ist-daten-v2-{year}-{month}.zip';

// Time to the response headers, and the longest gap between two body chunks.
// A stalled transfer has to fail rather than sit there: in CI it would otherwise
// eat the whole job timeout.
const HEADERS_TIMEOUT = 30_000;
const IDLE_TIMEOUT = 120_000;
const REPORT_EVERY = 5000;

export function istdatenPath(year, month) {
	return path.join(ISTDATEN_DIR, `ist-daten-v2-${year}-${String(month).padStart(2, '0')}.zip`);
}

function istdatenUrl(year, month) {
	return ISTDATEN_URL.replaceAll('{year}', String(year)).replace(
		'{month}',
		String(month).padStart(2, '0')
	);
}

/** Aborts the controller's request unless a chunk arrives every IDLE_TIMEOUT. */
function idleGuard(controller) {
	let timer = null;
	const bump = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => controller.abort(new Error('no data for 120s')), IDLE_TIMEOUT);
	};
	return { bump, stop: () => timer && clearTimeout(timer) };
}

async function request(url, { headers = {}, method = 'GET' } = {}) {
	const controller = new AbortController();
	const headersTimer = setTimeout(
		() => controller.abort(new Error('no response headers for 30s')),
		HEADERS_TIMEOUT
	);
	try {
		const response = await fetch(url, {
			method,
			headers,
			signal: controller.signal,
			redirect: 'follow'
		});
		return { response, controller };
	} finally {
		clearTimeout(headersTimer);
	}
}

/**
 * Downloads `url` to `dest`, resuming a partial file.
 *
 * @returns {Promise<boolean>} whether any bytes moved; false means "already current"
 */
async function fetchTo(url, dest, label) {
	const { response: head } = await request(url, { method: 'HEAD' });
	if (head.status === 404) {
		const error = new Error(`${label}: not published yet (HTTP 404)`);
		error.status = 404;
		throw error;
	}
	if (!head.ok) throw new Error(`${label}: HTTP ${head.status} for ${url}`);
	const contentLength = head.headers.get('content-length');
	const size = contentLength === null ? null : Number(contentLength);
	const lastModified = head.headers.get('last-modified');

	const stamp = `${dest}.fetched`;
	if (fs.existsSync(dest) && size !== null && fs.statSync(dest).size === size) {
		const stamped = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : null;
		if (lastModified === null || stamped === lastModified) {
			log(`  ${label}: up to date (${mb(fs.statSync(dest).size)})`);
			return false;
		}
	}

	ensureDir(path.dirname(dest));
	const part = `${dest}.part`;
	let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
	// Only resume when we know the target size and haven't overshot it.
	if (size !== null && have >= size) have = 0;

	const started = performance.now();
	const { response, controller } = await request(url, {
		headers: have ? { Range: `bytes=${have}-` } : {}
	});
	if (have && response.status !== 206) have = 0; // server ignored the range - start over
	if (!response.ok) throw new Error(`${label}: HTTP ${response.status} for ${url}`);
	if (!response.body) throw new Error(`${label}: empty response body`);

	let total = size;
	if (total === null) {
		const remaining = Number(response.headers.get('content-length') ?? 0);
		total = remaining > 0 ? have + remaining : null;
	}
	const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
	const idle = idleGuard(controller);
	let done = have;
	let nextReport = performance.now() + REPORT_EVERY;

	try {
		idle.bump();
		for await (const chunk of Readable.fromWeb(response.body)) {
			idle.bump();
			if (!out.write(chunk)) await once(out, 'drain');
			done += chunk.length;
			if (performance.now() >= nextReport) {
				const pct = total ? `${((100 * done) / total).toFixed(0)}%` : '?';
				const rate = done / Math.max(1e-6, (performance.now() - started) / 1000) / 1e6;
				log(`  ${label}: ${pct} (${mb(done)}, ${rate.toFixed(1)} MB/s)`);
				nextReport = performance.now() + REPORT_EVERY;
			}
		}
	} finally {
		idle.stop();
		await new Promise((resolve, reject) =>
			out.end((error) => (error ? reject(error) : resolve()))
		);
	}

	fs.renameSync(part, dest);
	if (lastModified) fs.writeFileSync(stamp, lastModified);
	log(`  ${label}: ${mb(fs.statSync(dest).size)} in ${((performance.now() - started) / 1000).toFixed(0)}s`);
	return true;
}

/** Downloads the current geops GTFS feed (rebuilt daily). */
export async function gtfs() {
	await fetchTo(GTFS_URL, GTFS_ZIP, 'gtfs_complete.zip');
	return GTFS_ZIP;
}

/**
 * Downloads one monthly Ist-Daten archive per [year, month].
 *
 * A month that isn't published yet is reported and skipped, so a run started too
 * early in the month still builds from the archives that do exist.
 *
 * @returns {Promise<string[]>} the archives now on disk
 */
export async function istdaten(months) {
	const paths = [];
	for (const [year, month] of months) {
		const dest = istdatenPath(year, month);
		try {
			await fetchTo(istdatenUrl(year, month), dest, path.basename(dest));
		} catch (error) {
			if (error.status === 404) {
				log(`  ${path.basename(dest)}: not published yet (HTTP 404) - skipping`);
				continue;
			}
			throw error;
		}
		paths.push(dest);
	}
	return paths;
}
