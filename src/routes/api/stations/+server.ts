import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPlanner } from '$lib/server/data';

export const GET: RequestHandler = ({ url }) => {
	const planner = getPlanner();
	if (!planner.isReady()) {
		return json({ error: 'Die Daten werden noch geladen. Bitte versuch es gleich nochmal.' }, { status: 503 });
	}

	const q = url.searchParams.get('q') ?? undefined;
	const latParam = url.searchParams.get('lat');
	const lonParam = url.searchParams.get('lon');
	const lat = latParam ? Number(latParam) : undefined;
	const lon = lonParam ? Number(lonParam) : undefined;
	const radiusParam = url.searchParams.get('radius');
	const radius = radiusParam ? Number(radiusParam) : undefined;
	const limitParam = url.searchParams.get('limit');
	const limit = limitParam ? Number(limitParam) : 10;
	if (!q && (lat == null || lon == null)) {
		return json({ error: 'Bitte einen Suchbegriff oder Standort angeben.' }, { status: 400 });
	}

	const results = planner.searchStations({ q, lat, lon, radius, limit });
	return json({ query: { q, lat, lon, radius, limit }, count: results.length, results });
};
