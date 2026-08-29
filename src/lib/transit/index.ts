import { TransitPlanner } from './planner';

// The app's single planner instance. Everything it loads (metadata, stops
// index, timetables, delay shards) stays cached on it for the session, so
// repeated searches only pay for data they haven't fetched yet.
export const planner = new TransitPlanner();

export { TransitError } from './planner';
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
