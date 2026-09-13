import { TransitPlanner } from './planner';

// The app's single planner instance. What it loads (metadata, stops index,
// delay shards) stays cached on it for the session, so repeated searches only
// pay for data they haven't fetched yet. Timetables are the exception: it keeps
// only the ones last asked for, since a phone can't hold more.
export const planner = new TransitPlanner();

export { TransitError, PREVIOUS_DAY_TAIL_CUTOFF } from './planner';
export type {
	DeparturesResult,
	DepartureDto,
	DepartureEventDto,
	DepartureListResult,
	Direction,
	StaticMeta,
	StopDto
} from './planner';
export { addDays, dayTypeOf, isoDate, parseIsoDate } from './time';
export type { DayType } from './time';
export { holidayName, isHoliday } from './holidays';
