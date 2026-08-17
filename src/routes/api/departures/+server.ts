import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPlanner } from '$lib/server/data';
import { HttpError } from '$lib/server/planner';

export const GET: RequestHandler = ({ url }) => {
	const planner = getPlanner();
	if (!planner.isReady()) {
		return json({ error: 'Die Daten werden noch geladen. Bitte versuch es gleich nochmal.' }, { status: 503 });
	}

	try {
		const result = planner.getDepartures({
			from: url.searchParams.get('from'),
			time: url.searchParams.get('time') ?? undefined,
			dayType: url.searchParams.get('dayType')
		});
		return json(result);
	} catch (err) {
		if (err instanceof HttpError) return json({ error: err.message }, { status: err.status });
		throw err;
	}
};
