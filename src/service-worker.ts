/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { base, build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

// App shell: the built JS/CSS plus everything in static/ - except the data
// bundle (static/data/, ~200 MB), which is cached lazily as it is used.
const SHELL_CACHE = `shell-${version}`;
const DATA_CACHE = 'data-v1';
const FONT_CACHE = 'fonts-v1';

const dataPrefix = `${base}/data/`;
const shell = [`${base}/`, ...build, ...files.filter((f) => !f.startsWith(dataPrefix))];
const shellSet = new Set(shell);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(SHELL_CACHE)
			.then((cache) => cache.addAll(shell))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key.startsWith('shell-') && key !== SHELL_CACHE) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

async function networkFirst(request: Request, cacheName: string): Promise<Response> {
	const cache = await caches.open(cacheName);
	try {
		const response = await fetch(request);
		if (response.ok) cache.put(request, response.clone());
		return response;
	} catch (err) {
		const cached = await cache.match(request);
		if (cached) return cached;
		throw err;
	}
}

async function staleWhileRevalidate(request: Request, cacheName: string): Promise<Response> {
	const cache = await caches.open(cacheName);
	const cached = await cache.match(request);
	const refresh = fetch(request)
		.then((response) => {
			if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
			return response;
		})
		.catch(() => undefined);
	return cached ?? (await refresh) ?? Response.error();
}

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);

	// Google Fonts (stylesheet + font files).
	if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
		event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
		return;
	}

	if (url.origin !== sw.location.origin) return;

	// Timetable/delay data: always try the network (it is rebuilt regularly),
	// fall back to whatever was fetched before when offline.
	if (url.pathname.startsWith(dataPrefix)) {
		event.respondWith(networkFirst(request, DATA_CACHE));
		return;
	}

	// Page navigation: the app is a single prerendered page.
	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request).catch(async () => (await caches.match(`${base}/`)) ?? Response.error())
		);
		return;
	}

	// Hashed build output and static files: cache first.
	if (shellSet.has(url.pathname)) {
		event.respondWith(
			caches.match(request).then((cached) => cached ?? fetch(request))
		);
	}
});
