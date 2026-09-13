// ---------------------------------------------------------------------------
// A departure board's view of a minotor timetable file, read straight from its
// bytes.
//
// minotor's own Timetable.fromData builds a JavaScript object for every route
// pattern in the file - ~215 000 of them, each with its own typed arrays and a
// Map of its stops - which comes to several hundred MB of heap for a ~40 MB
// file, and Safari on an iPhone kills the tab not far above that. A departure
// board reads little of it: which patterns call at a stop, their stops, and when
// each trip leaves. So this copies exactly that into a handful of flat typed
// arrays - 23-36 MB per weekday, where minotor's objects take ~630 MB - and
// lets the file go.
//
// The file is minotor's protobuf message minotor.timetable.v1.Timetable (see
// node_modules/minotor/dist/timetable/proto/v1/timetable.d.ts), written by the
// same pinned minotor in the pipeline. The fields read:
//
//   Timetable      1 stopsAdjacency   repeated StopAdjacency, one per stop id
//                  2 routesAdjacency  repeated Route, one per route id
//                  3 serviceRoutes    repeated ServiceRoute, one per service id
//   StopAdjacency  1 routes           uint32 route ids, packed
//   Route          1 stopTimes        bytes: u16 LE arrival, departure per trip x stop
//                  3 stops            bytes: u32 LE stop ids
//                  4 serviceRouteId   uint32
//   ServiceRoute   1 type             enum, numbered like minotor's RouteTypes
//                  2 name             string
//
// The classes keep the names and semantics of the minotor methods the planner
// calls, so either implementation can stand behind it.
// ---------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

const STOPS_ADJACENCY = 1;
const ROUTES = 2;
const SERVICE_ROUTES = 3;

const PACKED_ROUTES = (1 << 3) | WIRE_LENGTH;
const SINGLE_ROUTE = (1 << 3) | WIRE_VARINT;
const STOP_TIMES = (1 << 3) | WIRE_LENGTH;
const STOPS = (3 << 3) | WIRE_LENGTH;
const SERVICE_ROUTE_ID = (4 << 3) | WIRE_VARINT;
const SERVICE_TYPE = (1 << 3) | WIRE_VARINT;
const SERVICE_NAME = (2 << 3) | WIRE_LENGTH;

/** The highest route type minotor knows (MONORAIL); anything above reads as unknown. */
const MAX_ROUTE_TYPE = 10;

/** The service a pattern is shown to riders as. */
export type ServiceRouteInfo = { type: number; name: string };

function corrupt(detail: string): Error {
	return new Error(`Die Fahrplandaten sind beschädigt (${detail}).`);
}

/** A position in the file, and the protobuf primitives it is made of. */
class Reader {
	readonly bytes: Uint8Array;
	pos: number;
	end: number;

	constructor(bytes: Uint8Array, start = 0, end = bytes.length) {
		this.bytes = bytes;
		this.pos = start;
		this.end = end;
	}

	/** A varint as uint32; bits past the 32nd are dropped, as minotor does. */
	varint(): number {
		const bytes = this.bytes;
		let value = 0;
		let shift = 0;
		let byte;
		do {
			byte = bytes[this.pos++];
			if (shift < 32) value |= (byte & 0x7f) << shift;
			shift += 7;
		} while (byte & 0x80);
		return value >>> 0;
	}

	skip(wireType: number): void {
		switch (wireType) {
			case WIRE_VARINT:
				this.varint();
				break;
			case WIRE_FIXED64:
				this.pos += 8;
				break;
			case WIRE_LENGTH: {
				const length = this.varint();
				this.pos += length;
				break;
			}
			case WIRE_FIXED32:
				this.pos += 4;
				break;
			default:
				throw corrupt(`wire type ${wireType}`);
		}
	}
}

/** Calls `visit` for every stop, route and service entry of the file, in order. */
function forEachEntry(data: Uint8Array, visit: (field: number, entry: Reader) => void): void {
	const top = new Reader(data);
	const entry = new Reader(data);
	while (top.pos < top.end) {
		const tag = top.varint();
		const field = tag >>> 3;
		if ((tag & 7) !== WIRE_LENGTH || field < STOPS_ADJACENCY || field > SERVICE_ROUTES) {
			top.skip(tag & 7);
			continue;
		}
		const length = top.varint();
		entry.pos = top.pos;
		entry.end = top.pos + length;
		top.pos = entry.end;
		visit(field, entry);
	}
	if (top.pos !== top.end) throw corrupt('truncated');
}

/** Reads a StopAdjacency's route ids into `into` from `at` - or, without `into`, only counts them. */
function readStopRoutes(entry: Reader, into: Uint32Array | null, at: number): number {
	while (entry.pos < entry.end) {
		const tag = entry.varint();
		if (tag === PACKED_ROUTES) {
			const length = entry.varint();
			const end = entry.pos + length;
			while (entry.pos < end) {
				const id = entry.varint();
				if (into) into[at] = id;
				at++;
			}
		} else if (tag === SINGLE_ROUTE) {
			const id = entry.varint();
			if (into) into[at] = id;
			at++;
		} else {
			entry.skip(tag & 7);
		}
	}
	return at;
}

/** Where a Route message keeps its parts; reused, since there are ~215 000 of them. */
const route = { timesStart: 0, timesLength: 0, stopsStart: 0, stopsLength: 0, service: 0 };

function readRoute(entry: Reader): void {
	route.timesStart = route.timesLength = route.stopsStart = route.stopsLength = route.service = 0;
	while (entry.pos < entry.end) {
		const tag = entry.varint();
		if (tag === STOP_TIMES) {
			route.timesLength = entry.varint();
			route.timesStart = entry.pos;
			entry.pos += route.timesLength;
		} else if (tag === STOPS) {
			route.stopsLength = entry.varint();
			route.stopsStart = entry.pos;
			entry.pos += route.stopsLength;
		} else if (tag === SERVICE_ROUTE_ID) {
			route.service = entry.varint();
		} else {
			entry.skip(tag & 7);
		}
	}
	const nbStops = route.stopsLength / 4;
	const events = route.timesLength / 4;
	if (!Number.isInteger(nbStops) || !Number.isInteger(nbStops ? events / nbStops : events)) {
		throw corrupt('route');
	}
}

const service = { type: 0, nameStart: 0, nameLength: 0 };

function readService(entry: Reader): void {
	service.type = service.nameStart = service.nameLength = 0;
	while (entry.pos < entry.end) {
		const tag = entry.varint();
		if (tag === SERVICE_TYPE) {
			service.type = entry.varint();
		} else if (tag === SERVICE_NAME) {
			service.nameLength = entry.varint();
			service.nameStart = entry.pos;
			entry.pos += service.nameLength;
		} else {
			entry.skip(tag & 7);
		}
	}
}

type Columns = {
	/** stopRoutes[stopRouteStart[s] .. stopRouteStart[s + 1]) are the routes calling at stop s. */
	stopRouteStart: Uint32Array;
	stopRoutes: Uint32Array;
	/** routeStops[routeStopStart[r] .. routeStopStart[r + 1]) are route r's stops. */
	routeStopStart: Uint32Array;
	routeStops: Uint32Array;
	/** departures[routeDepartureStart[r] ..) are route r's departure minutes, trip by trip. */
	routeDepartureStart: Uint32Array;
	departures: Uint16Array;
	routeService: Uint32Array;
	serviceType: Uint8Array;
	serviceName: Uint32Array;
	/** Each distinct service name once; there are far fewer names than services. */
	names: string[];
};

export class Timetable {
	private readonly columns: Columns;

	private constructor(columns: Columns) {
		this.columns = columns;
	}

	/** Reads a timetable file. Nothing in the result refers back to `data`. */
	static fromData(data: Uint8Array): Timetable {
		// The first pass only measures, so each column is allocated once at its
		// final size rather than grown - and never exists twice.
		let stopCount = 0;
		let stopRouteCount = 0;
		let routeCount = 0;
		let routeStopCount = 0;
		let departureCount = 0;
		let serviceCount = 0;
		forEachEntry(data, (field, entry) => {
			if (field === STOPS_ADJACENCY) {
				stopCount++;
				stopRouteCount = readStopRoutes(entry, null, stopRouteCount);
			} else if (field === ROUTES) {
				routeCount++;
				readRoute(entry);
				routeStopCount += route.stopsLength / 4;
				departureCount += route.timesLength / 4;
			} else {
				serviceCount++;
			}
		});

		const columns: Columns = {
			stopRouteStart: new Uint32Array(stopCount + 1),
			stopRoutes: new Uint32Array(stopRouteCount),
			routeStopStart: new Uint32Array(routeCount + 1),
			routeStops: new Uint32Array(routeStopCount),
			routeDepartureStart: new Uint32Array(routeCount + 1),
			departures: new Uint16Array(departureCount),
			routeService: new Uint32Array(routeCount),
			serviceType: new Uint8Array(serviceCount),
			serviceName: new Uint32Array(serviceCount),
			names: []
		};
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const decoder = new TextDecoder();
		const nameIds = new Map<string, number>();
		let stop = 0;
		let stopRoute = 0;
		let routeId = 0;
		let routeStop = 0;
		let departure = 0;
		let serviceId = 0;

		forEachEntry(data, (field, entry) => {
			if (field === STOPS_ADJACENCY) {
				columns.stopRouteStart[stop++] = stopRoute;
				stopRoute = readStopRoutes(entry, columns.stopRoutes, stopRoute);
			} else if (field === ROUTES) {
				readRoute(entry);
				columns.routeStopStart[routeId] = routeStop;
				columns.routeDepartureStart[routeId] = departure;
				columns.routeService[routeId] = route.service;
				routeId++;
				for (let at = route.stopsStart; at < route.stopsStart + route.stopsLength; at += 4) {
					columns.routeStops[routeStop++] = view.getUint32(at, true);
				}
				// Every second u16 is a departure; the one before it is the arrival.
				for (let at = route.timesStart + 2; at < route.timesStart + route.timesLength; at += 4) {
					columns.departures[departure++] = view.getUint16(at, true);
				}
			} else {
				readService(entry);
				const name = decoder.decode(
					data.subarray(service.nameStart, service.nameStart + service.nameLength)
				);
				let nameId = nameIds.get(name);
				if (nameId === undefined) {
					nameId = columns.names.length;
					columns.names.push(name);
					nameIds.set(name, nameId);
				}
				columns.serviceType[serviceId] = service.type <= MAX_ROUTE_TYPE ? service.type : 0;
				columns.serviceName[serviceId] = nameId;
				serviceId++;
			}
		});
		columns.stopRouteStart[stop] = stopRoute;
		columns.routeStopStart[routeId] = routeStop;
		columns.routeDepartureStart[routeId] = departure;
		return new Timetable(columns);
	}

	/** The route patterns calling at a stop, in the file's order. */
	routesPassingThrough(stopId: number): TimetableRoute[] {
		const { stopRouteStart, stopRoutes, routeService } = this.columns;
		if (!(stopId >= 0 && stopId < stopRouteStart.length - 1)) return [];
		const routes: TimetableRoute[] = [];
		for (let i = stopRouteStart[stopId]; i < stopRouteStart[stopId + 1]; i++) {
			if (stopRoutes[i] < routeService.length) routes.push(this.route(stopRoutes[i]));
		}
		return routes;
	}

	getServiceRouteInfo(route: TimetableRoute): ServiceRouteInfo {
		const { serviceType, serviceName, names } = this.columns;
		const id = route.serviceRoute();
		if (id >= serviceType.length) throw new Error(`Service route not found for route ID: ${id}`);
		return { type: serviceType[id], name: names[serviceName[id]] };
	}

	private route(id: number): TimetableRoute {
		const c = this.columns;
		return new TimetableRoute(
			id,
			c.routeService[id],
			c.routeStops.subarray(c.routeStopStart[id], c.routeStopStart[id + 1]),
			c.departures.subarray(c.routeDepartureStart[id], c.routeDepartureStart[id + 1])
		);
	}
}

/** One route pattern: the trips of a service that share a list of stops, in departure order. */
export class TimetableRoute {
	readonly id: number;
	private readonly serviceRouteId: number;
	private readonly stops: Uint32Array;
	/** Departure minutes trip by trip: trip 0 at every stop, then trip 1, ... */
	private readonly departures: Uint16Array;
	private readonly nbStops: number;
	private readonly nbTrips: number;

	constructor(id: number, serviceRouteId: number, stops: Uint32Array, departures: Uint16Array) {
		this.id = id;
		this.serviceRouteId = serviceRouteId;
		this.stops = stops;
		this.departures = departures;
		this.nbStops = stops.length;
		this.nbTrips = stops.length ? departures.length / stops.length : 0;
	}

	getNbStops(): number {
		return this.nbStops;
	}

	getNbTrips(): number {
		return this.nbTrips;
	}

	serviceRoute(): number {
		return this.serviceRouteId;
	}

	stopId(stopIndex: number): number {
		return this.stops[stopIndex];
	}

	/** Every position of a stop in the pattern; a loop can call at a stop twice. */
	stopRouteIndices(stopId: number): number[] {
		const indices: number[] = [];
		for (let i = 0; i < this.nbStops; i++) if (this.stops[i] === stopId) indices.push(i);
		return indices;
	}

	departureFrom(stopIndex: number, tripIndex: number): number {
		return this.departures[tripIndex * this.nbStops + stopIndex];
	}

	/** The first trip departing the stop at or after `after`, by binary search. */
	findEarliestTrip(stopIndex: number, after = 0): number | undefined {
		let low = 0;
		let high = this.nbTrips - 1;
		let found: number | undefined;
		while (low <= high) {
			const mid = (low + high) >>> 1;
			if (this.departureFrom(stopIndex, mid) < after) {
				low = mid + 1;
			} else {
				found = mid;
				high = mid - 1;
			}
		}
		return found;
	}
}
