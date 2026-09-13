#!/usr/bin/env node
/**
 * Cuts a timetable down to the trips that are still departing after midnight.
 *
 *     node pipeline/tail.js <timetable.bin> <tail.bin>
 *
 * A trip belongs to the service day it started on, so a departure at 00:30 on a
 * Tuesday usually sits in Monday's timetable, at 24:30. A lookup in the small
 * hours therefore reads two service days - and two whole timetables are more
 * than a phone lets a tab hold: parsed, each takes several hundred MB. All that
 * lookup reads of the previous day are its trips past 24:00, so this writes
 * those, in minotor's own format, for the browser to load instead.
 *
 * Trips are kept whole and their times untouched: the patterns, their stops and
 * the order of their trips stay those of the full timetable, which is what lets
 * the planner read the tail exactly as it read the full timetable.
 *
 * A separate process for the same reason as parse-gtfs: a full timetable takes
 * more heap than Node gives a small machine by default.
 */

import fs from 'node:fs';
import process from 'node:process';
import { Timetable } from 'minotor';

import { die, log, num } from './layout.js';

const MINUTES_PER_DAY = 24 * 60;

const [source, dest] = process.argv.slice(2);
if (!source || !dest) die('usage: node pipeline/tail.js <timetable.bin> <tail.bin>');

const full = Timetable.fromData(new Uint8Array(fs.readFileSync(source)));

const routes = [];
const serviceRoutes = [];
// The full timetable's ids to the tail's.
const routeIds = new Map();
const serviceIds = new Map();
let patternCount = 0;
let tripCount = 0;

for (let id = 0; ; id++) {
	const route = full.getRoute(id);
	if (!route) break;
	patternCount++;
	const nbStops = route.getNbStops();
	const trips = [];
	for (let trip = 0; trip < route.getNbTrips(); trip++) {
		// The last stop is no departure, see collectFrom() in planner.ts.
		let pastMidnight = false;
		for (let stop = 0; stop < nbStops - 1 && !pastMidnight; stop++) {
			pastMidnight = route.departureFrom(stop, trip) >= MINUTES_PER_DAY;
		}
		if (!pastMidnight) continue;
		trips.push({
			stops: Array.from(route.stops, (stopId, stop) => ({
				id: stopId,
				arrivalTime: route.arrivalAt(stop, trip),
				departureTime: route.departureFrom(stop, trip),
				pickUpType: route.pickUpTypeFrom(stop, trip),
				dropOffType: route.dropOffTypeAt(stop, trip)
			}))
		});
	}
	if (trips.length === 0) continue;

	let serviceId = serviceIds.get(route.serviceRoute());
	if (serviceId === undefined) {
		serviceId = serviceRoutes.length;
		serviceIds.set(route.serviceRoute(), serviceId);
		serviceRoutes.push({ ...full.getServiceRouteInfo(route), routes: [] });
	}
	// minotor exports its routing module's Route under that name, not this one.
	const tailRoute = route.constructor.of({ id: routes.length, serviceRouteId: serviceId, trips });
	serviceRoutes[serviceId].routes.push(tailRoute.id);
	routeIds.set(id, tailRoute.id);
	routes.push(tailRoute);
	tripCount += trips.length;
}

// Taken from the full timetable's own lists, so a stop's routes keep their order.
const stopsAdjacency = [];
for (let stop = 0; stop < full.nbStops(); stop++) {
	stopsAdjacency.push({
		routes: full
			.routesPassingThrough(stop)
			.map((route) => routeIds.get(route.id))
			.filter((id) => id !== undefined)
	});
}

fs.writeFileSync(dest, new Timetable(stopsAdjacency, routes, serviceRoutes).serialize());
log(
	`    ${num(tripCount)} trips past midnight on ${num(routes.length)} of ${num(patternCount)} patterns`
);
