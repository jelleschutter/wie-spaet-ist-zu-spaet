import { base } from '$app/paths';

// ---------------------------------------------------------------------------
// Loading the static data bundle (built by scripts/build-static-data.mjs).
//
// Everything under static/data/ is stored gzipped: the timetables shrink ~4x
// and static hosts like GitHub Pages don't compress `application/octet-stream`
// themselves. A host *may* however serve a `.gz` file with
// `Content-Encoding: gzip`, in which case the browser has already inflated it
// by the time we see the bytes - so check for the gzip magic number instead of
// assuming either behaviour.
// ---------------------------------------------------------------------------

/** URL of a file in the static data bundle, honouring a deployment base path. */
export function dataUrl(path: string): string {
	return `${base}/data/${path}`;
}

function isGzip(data: Uint8Array): boolean {
	return data.length > 2 && data[0] === 0x1f && data[1] === 0x8b;
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === 'undefined') {
		throw new Error('Dieser Browser unterstützt keine gzip-Dekomprimierung.');
	}
	const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Fetches a binary asset from the data bundle, inflating it when needed.
 * Returns null for a missing `optional` asset (e.g. a delay shard that holds
 * no data for the requested day type).
 */
export async function fetchBinary(
	path: string,
	options: { optional?: boolean } = {}
): Promise<Uint8Array | null> {
	const url = dataUrl(path);
	const res = await fetch(url);
	if (!res.ok) {
		if (options.optional && res.status === 404) return null;
		throw new Error(`Daten konnten nicht geladen werden (${path}: HTTP ${res.status}).`);
	}
	const data = new Uint8Array(await res.arrayBuffer());
	return isGzip(data) ? gunzip(data) : data;
}

/** Fetches a JSON file from the data bundle. */
export async function fetchJson<T>(path: string): Promise<T> {
	const res = await fetch(dataUrl(path));
	if (!res.ok) throw new Error(`Daten konnten nicht geladen werden (${path}: HTTP ${res.status}).`);
	return res.json() as Promise<T>;
}
