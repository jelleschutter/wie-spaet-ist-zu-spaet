import { json } from '@sveltejs/kit';
import { getPlanner } from '$lib/server/data';

export function GET() {
	const planner = getPlanner();
	return json({
		status: planner.isReady() ? 'ok' : 'starting',
		routing: { ready: planner.isReady(), serviceDays: planner.timetableDayTypes },
		delays: planner.delaysMeta
	});
}
