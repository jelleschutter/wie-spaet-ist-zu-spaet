<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import StationAutocomplete from '$lib/components/StationAutocomplete.svelte';
	import { recentStations, rememberStation, type RecentStation } from '$lib/recentStations';
	import { saveDelayScope, savedDelayScope } from '$lib/delayScope';
	import {
		addDays,
		dayTypeOf,
		holidayName,
		isHoliday,
		isoDate,
		parseIsoDate,
		planner,
		PREVIOUS_DAY_TAIL_CUTOFF,
		secondsToClock,
		TransitError,
		type DayType,
		type DelayScope,
		type DepartureDto,
		type DepartureEventDto,
		type Direction
	} from '$lib/transit';

	const DAY_TYPE_LABELS: Record<DayType, string> = {
		monday: 'Montag',
		tuesday: 'Dienstag',
		wednesday: 'Mittwoch',
		thursday: 'Donnerstag',
		friday: 'Freitag',
		saturday: 'Samstag',
		sunday: 'Sonntag'
	};

	/** "Montags": the statistics of one weekday, as the scope switch names them. */
	const DAY_TYPE_ADVERBS: Record<DayType, string> = {
		monday: 'Montags',
		tuesday: 'Dienstags',
		wednesday: 'Mittwochs',
		thursday: 'Donnerstags',
		friday: 'Freitags',
		saturday: 'Samstags',
		sunday: 'Sonntags'
	};

	type QueryMeta = { stationId: string; stationName: string; time: string; date: string };

	/** How many connections one "Früher"/"Später" step shows. */
	const PAGE_SIZE = 5;

	/** How many either side of the next (or current) departure the board opens with. */
	const AROUND_SIZE = 2;

	/** How many recent stations the start screen offers as chips. */
	const RECENT_CHIPS = 3;

	const DATE_WINDOW_DAYS = 14;

	const MINUTES_PER_DAY = 1440;

	const DATE_FORMAT = new Intl.DateTimeFormat('de-CH', {
		weekday: 'long',
		day: '2-digit',
		month: '2-digit'
	});

	const DAY_MONTH_FORMAT = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit' });

	const WEEKDAY_SHORT_FORMAT = new Intl.DateTimeFormat('de-CH', { weekday: 'short' });

	let screen = $state<'form' | 'board' | 'result'>('form');
	let stationName = $state('');
	let stationId = $state<string | null>(null);
	/** "Jetzt" keeps time and date on the current moment; "Später" lets you pick them. */
	let when = $state<'now' | 'later'>('now');
	let time = $state(new Date().toTimeString().slice(0, 5));
	let date = $state(isoDate(new Date()));
	let minDate = $state(isoDate(new Date()));
	let maxDate = $state(isoDate(addDays(new Date(), DATE_WINDOW_DAYS)));
	let serviceDays = $state<DayType[]>([dayTypeOf(new Date())]);
	let delaysReady = $state(false);
	let loadError = $state('');
	let recents = $state<RecentStation[]>([]);
	let statusMsg = $state('');
	let statusError = $state(false);
	let busy = $state(false);
	let listResults = $state<DepartureDto[]>([]);
	// Where the shown page begins and ends, in minutes: the anchors the next
	// "Früher"/"Später" pages off. Clock strings can't serve, they wrap at 24:00.
	let listEarliest = $state<number | null>(null);
	let listLatest = $state<number | null>(null);
	// Paging can walk off the queried date, so the shown page carries its own.
	let listDate = $state<string | null>(null);
	// The minute of the first departure the query found, marked on the board
	// until a result has been opened.
	let nextMinutes = $state<number | null>(null);
	let result = $state<DepartureDto | null>(null);
	let resultDayType = $state<DayType | null>(null);
	let queryMeta = $state<QueryMeta | null>(null);
	let toastMsg = $state('');
	let toastVisible = $state(false);
	/** The days the statistics are drawn from, as last picked. */
	let delayScope = $state<DelayScope>(savedDelayScope());
	/** The scopes the latest lookup has statistics for - all three, or just 'day'
	 *  with a bundle built before the pools existed. */
	let delayScopes = $state<DelayScope[]>(['day']);

	const dayType = $derived(dayTypeOf(parseIsoDate(date)));
	const selectedHoliday = $derived(holidayName(parseIsoDate(date)));
	const dayUnavailable = $derived(!serviceDays.includes(dayType));
	// The pick where the data has it, the finest one there is otherwise.
	const scope = $derived(delayScopes.includes(delayScope) ? delayScope : (delayScopes[0] ?? 'day'));

	/** A departure's statistics in the chosen scope. */
	function stats(dto: DepartureDto): DepartureEventDto {
		return dto.departure[scope];
	}

	function scopeLabel(option: DelayScope, dto: DepartureDto) {
		if (option === 'all') return 'Alle Tage';
		if (option === 'day') return DAY_TYPE_ADVERBS[dto.serviceDayType];
		return dto.serviceDayType === 'saturday' || dto.serviceDayType === 'sunday'
			? 'Wochenende'
			: 'Mo–Fr';
	}

	function setDelayScope(next: DelayScope) {
		delayScope = next;
		saveDelayScope(next);
	}

	function pad2(n: number) {
		return String(n).padStart(2, '0');
	}

	function formatDate(iso: string) {
		const day = parseIsoDate(iso);
		if (day.getDay() !== 0 && isHoliday(day)) return `Feiertag, ${DAY_MONTH_FORMAT.format(day)}`;
		return DATE_FORMAT.format(day);
	}

	/** "Di 22.09." */
	function shortDate(iso: string) {
		const day = parseIsoDate(iso);
		const weekday = WEEKDAY_SHORT_FORMAT.format(day).replace(/\.$/, '');
		return `${weekday} ${DAY_MONTH_FORMAT.format(day)}`;
	}

	function dayTypeOfMeta(meta: QueryMeta): DayType {
		return dayTypeOf(parseIsoDate(meta.date));
	}

	// Trips leaving just after midnight belong to the day before, so a lookup in
	// the small hours has to see that day's timetable too.
	function previousDayTypeOfMeta(meta: QueryMeta): DayType {
		return dayTypeOf(addDays(parseIsoDate(meta.date), -1));
	}

	/** Whether a lookup at this time still reaches the previous day's night services. */
	function needsPreviousDay(time: string): boolean {
		const [h, m] = time.split(':').map(Number);
		return Number.isFinite(h) && Number.isFinite(m) && h * 60 + m < PREVIOUS_DAY_TAIL_CUTOFF;
	}

	function nextDateOf(wanted: DayType): string {
		const today = new Date();
		for (let i = 0; i < 7; i++) {
			const candidate = addDays(today, i);
			if (dayTypeOf(candidate) === wanted) return isoDate(candidate);
		}
		return isoDate(today);
	}

	function linkDate(shared: string | null, sharedDayType: string | null): string {
		if (shared && /^\d{4}-\d{2}-\d{2}$/.test(shared)) {
			if (shared >= minDate && shared <= maxDate) return shared;
			return nextDateOf(dayTypeOf(parseIsoDate(shared)));
		}
		if (sharedDayType && serviceDays.includes(sharedDayType as DayType)) {
			return nextDateOf(sharedDayType as DayType);
		}
		return date;
	}

	function updateTimeToNow() {
		const now = new Date();
		time = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
	}

	function refreshDateWindow() {
		minDate = isoDate(new Date());
		maxDate = isoDate(addDays(new Date(), DATE_WINDOW_DAYS));
		if (date < minDate || date > maxDate) date = minDate;
	}

	function resetDefaults() {
		updateTimeToNow();
		date = isoDate(new Date());
		refreshDateWindow();
	}

	/** In "Jetzt" mode, moves time and date along with the clock. */
	function syncNow() {
		if (when === 'now') resetDefaults();
	}

	function setWhen(next: 'now' | 'later') {
		when = next;
		syncNow();
	}

	function fmtDuration(abs: number) {
		const m = Math.floor(abs / 60);
		const s = abs % 60;
		if (m > 0 && s > 0) return `${m} Min ${s} Sek`;
		if (m > 0) return `${m} Min`;
		return `${s} Sek`;
	}

	/** "40 s", "1:10" - with a sign when `signed`, as delays on the board carry one. */
	function fmtSeconds(seconds: number, signed = false) {
		const abs = Math.abs(seconds);
		const sign = seconds < 0 ? '−' : signed && seconds > 0 ? '+' : '';
		const mag = abs < 60 ? `${abs} s` : `${Math.floor(abs / 60)}:${pad2(abs % 60)}`;
		return sign + mag;
	}

	/** The modes that run on rails, and so stop at a Gleis rather than a Kante. */
	const TRACK_MODES = new Set(['RAIL', 'SUBWAY', 'FUNICULAR']);

	function platformWord(mode: string) {
		return TRACK_MODES.has(mode) ? 'Gleis' : 'Kante';
	}

	/** Whether another departure on the page leaves in the same minute. */
	function sharesMinute(items: DepartureDto[], dto: DepartureDto) {
		return items.some((r) => r !== dto && r.plannedDepartureMinutes === dto.plannedDepartureMinutes);
	}

	/**
	 * The result headline: the latest you can be at the platform, as a clock
	 * time - the planned departure plus the buffer that still catches it in
	 * 9 of 10 cases.
	 */
	function heroInfo(dto: DepartureDto) {
		const buffer = stats(dto).catchBufferSeconds;
		if (buffer == null) {
			return {
				clock: null,
				note: delaysReady
					? 'Für diese Verbindung liegen keine Verspätungsdaten vor.'
					: 'Für diesen Fahrplan liegen keine Verspätungsdaten vor.'
			};
		}
		const planned = (dto.plannedDepartureMinutes % MINUTES_PER_DAY) * 60;
		return {
			clock: secondsToClock(planned + buffer),
			note:
				buffer < 0
					? `Das ist ${fmtDuration(-buffer)} vor der Planzeit – dann erwischst du den Zug in`
					: 'Dann erwischst du den Zug in'
		};
	}

	/** Labels closer than this (in % of the track) would overlap. */
	const LABEL_GAP = 10;

	/**
	 * The timeline under the headline: seconds after the planned departure,
	 * 0-60 unless the buffer or the average reach past either end, with a
	 * marker for each. Positions are percentages of the track.
	 */
	function timeline(dto: DepartureDto) {
		const avg = stats(dto).delaySeconds;
		const buffer = stats(dto).catchBufferSeconds;
		const values = [avg, buffer].filter((v): v is number => v != null);
		if (!values.length) return null;
		const lo = Math.min(0, ...values.map((v) => Math.floor(v / 30) * 30));
		const hi = Math.max(60, ...values.map((v) => Math.ceil(v / 30) * 30));
		const pos = (s: number) => ((s - lo) / (hi - lo)) * 100;
		const bufferPos = buffer == null ? null : pos(buffer);
		const avgPos = avg == null ? null : pos(avg);
		const markers = [bufferPos, avgPos].filter((p): p is number => p != null);
		const clear = (p: number) => markers.every((m) => Math.abs(m - p) >= LABEL_GAP);
		const zero = pos(0);
		return {
			lo,
			hi,
			zero,
			buffer,
			bufferPos,
			avg,
			avgPos,
			showLo: clear(0),
			showHi: clear(100),
			showAvgTop: avgPos != null && (bufferPos == null || Math.abs(avgPos - bufferPos) >= LABEL_GAP),
			// "Fahrplan" and "Ø Abfahrt" are words, so they need more room than a number.
			showAvgBottom: avgPos != null && Math.abs(avgPos - zero) >= 2 * LABEL_GAP
		};
	}

	/** ":09" within the first minute, "1:30" / "−0:20" beyond it. */
	function tickLabel(s: number) {
		if (s >= 0 && s <= 60) return `:${pad2(s)}`;
		const abs = Math.abs(s);
		return `${s < 0 ? '−' : ''}${Math.floor(abs / 60)}:${pad2(abs % 60)}`;
	}

	/** Keeps a label inside the track: flush left or right near the ends, centred elsewhere. */
	function anchor(p: number) {
		return p < 8 ? 'start' : p > 92 ? 'end' : 'mid';
	}

	function buildShareUrl(dto: DepartureDto, meta: QueryMeta): URL {
		const params = new URLSearchParams();
		params.set('station', meta.stationId);
		params.set('stationName', meta.stationName);
		params.set('time', meta.time);
		params.set('date', meta.date);
		params.set('line', dto.line);
		if (dto.destination?.id != null) params.set('dest', String(dto.destination.id));
		// The deep link lives in the fragment, which never reaches the server: every
		// shared link is then the same URL to a cache, instead of one entry per
		// query string that can only ever miss.
		const url = new URL(location.href);
		url.search = '';
		url.hash = params.toString();
		return url;
	}

	function showResult(dto: DepartureDto, meta: QueryMeta, dayTypeUsed: DayType | null) {
		result = dto;
		queryMeta = meta;
		resultDayType = dayTypeUsed;
		screen = 'result';
		replaceState(buildShareUrl(dto, meta), {});
	}

	async function runSearch(meta: QueryMeta, pick?: { line: string; dest: string | null }) {
		busy = true;
		listDate = null;
		nextMinutes = null;
		result = null;
		const metaDayType = dayTypeOfMeta(meta);
		// The first lookup of a day type pulls in its timetable (a few MB), which
		// takes noticeably longer than the search itself — say so. In the small
		// hours the previous day's trips past midnight come on top.
		const ready = planner.isReady(
			metaDayType,
			needsPreviousDay(meta.time) ? previousDayTypeOfMeta(meta) : null
		);
		statusMsg = ready ? 'Suche läuft …' : 'Fahrplandaten werden geladen …';
		statusError = false;
		try {
			const data = await planner.getDepartures({
				from: meta.stationId,
				time: meta.time,
				dayType: metaDayType,
				previousDayType: previousDayTypeOfMeta(meta)
			});
			if (!data.results.length) {
				statusMsg = `Keine weiteren Abfahrten ab ${meta.stationName || meta.stationId} nach ${meta.time} Uhr am ${formatDate(meta.date)}`;
				statusError = true;
				return;
			}
			statusMsg = '';
			// The stop the query resolved to, not what was typed: recents are then
			// offered back under the canonical name and re-search by id. The source
			// stop id is the feed's own and survives a data:build; minotor's internal
			// id is a position in stops.txt and shifts whenever the feed does.
			const stopId = data.query.from.sourceStopId ?? String(data.query.from.id);
			rememberStation({ id: stopId, name: data.query.from.name });
			// A shared link should carry that same id rather than the typed name,
			// which can rank onto a different station once the feed changes.
			meta = { ...meta, stationId: stopId, stationName: data.query.from.name };
			resultDayType = data.dayType;
			delayScopes = data.delayScopes;
			const preselected = pick
				? data.results.find(
						(r) =>
							r.line === pick.line && (pick.dest == null || String(r.destination?.id) === pick.dest)
					)
				: undefined;
			if (preselected) {
				showResult(preselected, meta, data.dayType);
				return;
			}
			// The board opens on the next departure, with a few either side of it.
			queryMeta = meta;
			nextMinutes = data.results[0].plannedDepartureMinutes;
			await showPage('around', nextMinutes, AROUND_SIZE, meta.date);
		} catch (err) {
			statusMsg =
				err instanceof TransitError
					? err.message
					: 'Anfrage fehlgeschlagen: ' + (err as Error).message;
			statusError = true;
		} finally {
			busy = false;
		}
	}

	/** The minutes the shown departures span, whichever screen is showing them. */
	function shownWindow(): { earliest: number; latest: number; date: string } | null {
		if (screen === 'board' && listEarliest != null && listLatest != null && listDate) {
			return { earliest: listEarliest, latest: listLatest, date: listDate };
		}
		if (screen !== 'result' || !result || !queryMeta) return null;
		return {
			earliest: result.plannedDepartureMinutes,
			latest: result.plannedDepartureMinutes,
			date: queryMeta.date
		};
	}

	function fetchPage(direction: Direction, at: number, limit: number, date: string) {
		const day = parseIsoDate(date);
		return planner.getDepartureList({
			from: (queryMeta as QueryMeta).stationId,
			at,
			dayType: dayTypeOf(day),
			previousDayType: dayTypeOf(addDays(day, -1)),
			direction,
			limit
		});
	}

	/** The neighbouring date in `direction`, or null at the edge of the window. */
	function rolledDate(date: string, direction: Direction): string | null {
		const next = isoDate(addDays(parseIsoDate(date), direction === 'earlier' ? -1 : 1));
		return next < minDate || next > maxDate ? null : next;
	}

	async function showPage(direction: Direction, at: number, limit: number, date: string) {
		if (!queryMeta) return;
		busy = true;
		statusMsg = '';
		statusError = false;
		try {
			let useDate = date;
			let useAt = at;
			let data = await fetchPage(direction, useAt, limit, useDate);

			// A date runs out of departures long before the timetable does, so an
			// empty page steps to the neighbouring one. Both boards measure from
			// their own midnight, which is all that separates the two anchors.
			if (!data.results.length && direction !== 'around') {
				const next = rolledDate(useDate, direction);
				if (!next) {
					statusMsg =
						direction === 'earlier'
							? 'Keine früheren Abfahrten im wählbaren Zeitraum.'
							: 'Keine späteren Abfahrten im wählbaren Zeitraum.';
					statusError = true;
					return;
				}
				useDate = next;
				useAt =
					direction === 'earlier'
						? at + MINUTES_PER_DAY
						: Math.max(0, at - MINUTES_PER_DAY);
				data = await fetchPage(direction, useAt, limit, useDate);
			}

			if (!data.results.length) {
				statusMsg = `Keine ${direction === 'earlier' ? 'früheren' : 'späteren'} Abfahrten am ${formatDate(useDate)}`;
				statusError = true;
				return;
			}
			listResults = data.results;
			listEarliest = data.earliest;
			listLatest = data.latest;
			listDate = useDate;
			resultDayType = data.dayType;
			delayScopes = data.delayScopes;
			screen = 'board';
		} catch (err) {
			statusMsg =
				err instanceof TransitError
					? err.message
					: 'Anfrage fehlgeschlagen: ' + (err as Error).message;
			statusError = true;
		} finally {
			busy = false;
		}
	}

	function goEarlier() {
		const window = shownWindow();
		if (window) showPage('earlier', window.earliest, PAGE_SIZE, window.date);
	}

	function goLater() {
		// A page always holds whole minutes, so starting one minute past the last
		// one shown skips exactly what's already on screen.
		const window = shownWindow();
		if (window) showPage('later', window.latest + 1, PAGE_SIZE, window.date);
	}

	function showAlternatives() {
		const window = shownWindow();
		if (window) showPage('around', window.earliest, AROUND_SIZE, window.date);
	}

	/**
	 * Whether a listed departure is the one the result screen was showing, so the
	 * board points out where you currently are in it.
	 */
	function isCurrent(dto: DepartureDto) {
		return (
			result != null &&
			// After a roll the page is a different date, where the same minute is
			// a different departure.
			listDate === queryMeta?.date &&
			dto.plannedDepartureMinutes === result.plannedDepartureMinutes &&
			dto.line === result.line &&
			(dto.destination?.id ?? null) === (result.destination?.id ?? null)
		);
	}

	/** Whether a listed departure is the next one the search found, before any was picked. */
	function isNext(dto: DepartureDto) {
		return (
			result == null &&
			nextMinutes != null &&
			listDate === queryMeta?.date &&
			dto.plannedDepartureMinutes === nextMinutes
		);
	}

	function pick(dto: DepartureDto) {
		const meta = queryMeta as QueryMeta;
		// A departure picked off the board is no longer the one the original query
		// asked for, so the shared link has to point at its own date and time -
		// and one past 24:00 belongs to the next date, counted from its midnight
		// so that paging on from here anchors in the same day the result names.
		const base = listDate ?? meta.date;
		const rolls = dto.plannedDepartureMinutes >= MINUTES_PER_DAY;
		const date = rolls ? isoDate(addDays(parseIsoDate(base), 1)) : base;
		const picked = rolls
			? { ...dto, plannedDepartureMinutes: dto.plannedDepartureMinutes - MINUTES_PER_DAY }
			: dto;
		showResult(picked, { ...meta, date, time: picked.plannedDeparture }, resultDayType);
	}

	function openPicker(e: MouseEvent) {
		const input = e.currentTarget as HTMLInputElement;
		if (typeof input.showPicker !== 'function') return;
		try {
			input.showPicker();
		} catch {
			/* schon offen */
		}
	}

	function search() {
		syncNow();
		const id = stationId ?? stationName.trim();
		if (!id) {
			statusMsg = 'Bitte gib einen Abfahrtsort ein.';
			statusError = true;
			return;
		}
		if (date < minDate || date > maxDate) {
			statusMsg = `Bitte wähle ein Datum zwischen dem ${formatDate(minDate)} und dem ${formatDate(maxDate)}`;
			statusError = true;
			return;
		}
		if (dayUnavailable) {
			statusMsg = `Für ${DAY_TYPE_LABELS[dayType]} liegen keine Fahrplandaten vor.`;
			statusError = true;
			return;
		}
		runSearch({ stationId: id, stationName, time, date });
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		search();
	}

	function pickRecent(r: RecentStation) {
		stationName = r.name;
		stationId = r.id;
		search();
	}

	function goAgain() {
		replaceState(location.pathname, {});
		result = null;
		listResults = [];
		listEarliest = null;
		listLatest = null;
		listDate = null;
		nextMinutes = null;
		queryMeta = null;
		statusMsg = '';
		recents = recentStations().slice(0, RECENT_CHIPS);
		// Keep the station and the date as they were; only the time needs to
		// move forward so a new search reflects the moment you're clicking it.
		updateTimeToNow();
		refreshDateWindow();
		syncNow();
		screen = 'form';
	}

	async function share() {
		if (!result || !queryMeta) return;
		const url = buildShareUrl(result, queryMeta).toString();
		if (navigator.share) {
			try {
				await navigator.share({ title: 'Wie spät ist zu spät?', url });
			} catch {
				/* Teilen abgebrochen */
			}
			return;
		}
		try {
			await navigator.clipboard.writeText(url);
			toastMsg = 'Link kopiert!';
		} catch {
			toastMsg = url;
		}
		toastVisible = true;
		setTimeout(() => (toastVisible = false), 1800);
	}

	// The timetable of the day in the form, pulled in while it is still being
	// filled in: the download is the slow part of a lookup, so by the time a
	// station and a time are picked it has usually already arrived. Re-runs on
	// every date change, and the planner drops what a new pick supersedes.
	$effect(() => {
		const day = parseIsoDate(date);
		planner.preload(dayTypeOf(day), needsPreviousDay(time) ? dayTypeOf(addDays(day, -1)) : null);
	});

	// Each screen starts at its top, wherever the last one was scrolled to.
	$effect(() => {
		void screen;
		window.scrollTo({ top: 0 });
	});

	onMount(() => {
		recents = recentStations().slice(0, RECENT_CHIPS);
		(async () => {
			// Start pulling the stops index in while the form is being filled in.
			planner.prewarm();
			try {
				const meta = await planner.meta();
				delaysReady = (meta.delays?.dayTypes?.length ?? 0) > 0;
				serviceDays = meta.serviceDays?.length ? meta.serviceDays : [dayTypeOf(new Date())];
			} catch {
				serviceDays = [dayTypeOf(new Date())];
				loadError = 'Die Fahrplandaten konnten nicht geladen werden.';
			}
			resetDefaults();

			// Links shared before the move to the fragment still carry a query string.
			const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
			const sId = params.get('station');
			if (!sId) return;
			const meta: QueryMeta = {
				stationId: sId,
				stationName: params.get('stationName') || sId,
				time: params.get('time') || time,
				date: linkDate(params.get('date'), params.get('dayType'))
			};
			when = 'later';
			stationId = meta.stationId;
			stationName = meta.stationName;
			time = meta.time;
			date = meta.date;
			const line = params.get('line');
			runSearch(meta, line ? { line, dest: params.get('dest') } : undefined);
		})();

		// "Jetzt" shows the current time, so it has to keep up with the clock.
		const tick = setInterval(() => {
			if (screen === 'form') syncNow();
		}, 15_000);
		return () => clearInterval(tick);
	});
</script>

<svelte:head>
	<title>Wie spät ist zu spät?</title>
</svelte:head>

{#snippet status()}
	{#if statusMsg}
		<p class="status" class:error={statusError} role="status">{statusMsg}</p>
	{/if}
{/snippet}

{#snippet lineBadge(line: string)}
	<span class="line-badge">{line}</span>
{/snippet}

<main class="screen-{screen}">
	{#if screen === 'form'}
		<header class="intro">
			<h1>Wie spät ist zu spät?</h1>
		</header>

		<form class="search" onsubmit={submit}>
			<StationAutocomplete bind:value={stationName} bind:stationId />

			<div class="when">
				<div class="segmented" role="group" aria-label="Abfahrtszeit">
					<button type="button" aria-pressed={when === 'now'} onclick={() => setWhen('now')}>
						Jetzt
					</button>
					<button type="button" aria-pressed={when === 'later'} onclick={() => setWhen('later')}>
						Später
					</button>
				</div>
				{#if when === 'now'}
					<span class="when-now">{time} · {shortDate(date)}</span>
				{/if}
			</div>

			{#if when === 'later'}
				<div class="when-fields">
					<div class="field">
						<label for="time">Zeit</label>
						<input type="time" id="time" bind:value={time} />
					</div>
					<div class="field">
						<label for="date">Datum</label>
						<input
							type="date"
							id="date"
							bind:value={date}
							min={minDate}
							max={maxDate}
							onclick={openPicker}
						/>
					</div>
				</div>
			{/if}
			{#if selectedHoliday}
				<p class="hint">{selectedHoliday} — es gilt der Sonntagsfahrplan.</p>
			{:else if dayUnavailable}
				<p class="hint">Für {DAY_TYPE_LABELS[dayType]} liegen keine Fahrplandaten vor.</p>
			{/if}

			<button class="btn btn-accent" type="submit" disabled={busy}>Abfahrten zeigen</button>
			{@render status()}
			{#if loadError}
				<p class="status error">{loadError}</p>
			{/if}
		</form>

		{#if recents.length}
			<section class="recents" aria-labelledby="recents-title">
				<h2 id="recents-title" class="label">Zuletzt</h2>
				<div class="chips">
					{#each recents as r (r.id)}
						<button type="button" class="chip" onclick={() => pickRecent(r)} disabled={busy}>
							{r.name}
						</button>
					{/each}
				</div>
			</section>
		{/if}
	{/if}

	{#if screen === 'board' && listResults.length}
		<header class="board-head">
			<button type="button" class="back" onclick={goAgain}>← Neue Suche</button>
			<div class="board-title">
				<h1>{queryMeta?.stationName || 'Abfahrten'}</h1>
				{#if queryMeta}<span class="board-clock">{queryMeta.time}</span>{/if}
			</div>
			<p class="board-sub">
				{#if listDate}{shortDate(listDate)} · {/if}Tippe deinen Zug an
			</p>
		</header>
		{@render status()}

		<div class="board">
			<div class="board-row board-columns" aria-hidden="true">
				<span>Zeit</span>
				<span>Nach</span>
				<span class="platform-col">
					{listResults.some((r) => TRACK_MODES.has(r.mode)) ? 'Gleis' : 'Kante'}
				</span>
			</div>
			<button class="pager" type="button" onclick={goEarlier} disabled={busy}>↑ Früher</button>
			{#each listResults as r (r.plannedDepartureMinutes + ':' + r.line + ':' + (r.destination?.id ?? ''))}
				{@const current = isCurrent(r)}
				{@const delay = stats(r).delaySeconds}
				<button
					type="button"
					class="board-row departure"
					class:selected={current || isNext(r)}
					aria-current={current ? 'true' : undefined}
					onclick={() => pick(r)}
				>
					<span class="dep-time">
						<span class="clock">{r.plannedDeparture}</span>
						{#if delay != null}<span class="delay">{fmtSeconds(delay, true)}</span>{/if}
					</span>
					<span class="dep-body">
						<span class="dep-line">
							{@render lineBadge(r.line)}
							<span class="dest">{r.destination?.name ?? '?'}</span>
						</span>
						<span class="dep-meta">
							{delay != null ? 'Ø Verspätung' : 'Keine Verspätungsdaten'}{#if sharesMinute(listResults, r)}&nbsp;· gleiche Zeit{/if}
						</span>
					</span>
					<span class="platform">
						{#if r.from.platform}<span class="sr-only">{platformWord(r.mode)} </span>{r.from.platform}{/if}
					</span>
				</button>
			{/each}
			<button class="pager" type="button" onclick={goLater} disabled={busy}>↓ Später</button>
		</div>
	{/if}

	{#if screen === 'result' && result}
		{@const hero = heroInfo(result)}
		{@const tl = timeline(result)}
		{@const st = stats(result)}
		<h1 class="sr-only">Wie spät ist zu spät?</h1>
		<button type="button" class="back" onclick={showAlternatives} disabled={busy}>
			← Andere Abfahrt
		</button>
		{@render status()}

		<div class="board-row departure-card">
			<span class="clock">{result.plannedDeparture}</span>
			<span class="dep-body">
				<span class="dep-line">
					{@render lineBadge(result.line)}
					<span class="dest">{result.destination?.name ?? '?'}</span>
				</span>
				<span class="dep-meta">
					{#if queryMeta}ab {queryMeta.stationName} · {shortDate(queryMeta.date)}{:else if resultDayType}{DAY_TYPE_LABELS[resultDayType]}{/if}
				</span>
			</span>
			<span class="platform">
				{#if result.from.platform}<span class="sr-only">{platformWord(result.mode)} </span>{result.from.platform}{/if}
			</span>
		</div>

		{#if delayScopes.length > 1}
			<div class="segmented scope" role="group" aria-label="Verspätungsdaten von">
				{#each delayScopes as option (option)}
					<button
						type="button"
						aria-pressed={scope === option}
						onclick={() => setDelayScope(option)}
					>
						{scopeLabel(option, result)}
					</button>
				{/each}
			</div>
		{/if}

		<section class="verdict">
			{#if hero.clock}
				<p class="verdict-label">Spätestens am Gleis</p>
				<p class="verdict-clock">{hero.clock}</p>
				<p class="verdict-note">{hero.note} <strong>9 von 10</strong> Fällen.</p>
			{:else}
				<p class="verdict-label">Keine Prognose möglich</p>
				<p class="verdict-note">{hero.note}</p>
			{/if}

			{#if tl}
				<div class="timeline" aria-hidden="true">
					<div class="tl-track"></div>
					{#if tl.bufferPos != null}
						<div
							class="tl-fill"
							style:left="{Math.min(tl.zero, tl.bufferPos)}%"
							style:width="{Math.abs(tl.bufferPos - tl.zero)}%"
						></div>
					{/if}
					{#if tl.showLo}<span class="tl-label tl-top anchor-start" style:left="0%">{tickLabel(tl.lo)}</span>{/if}
					{#if tl.showHi}<span class="tl-label tl-top anchor-end" style:left="100%">{tickLabel(tl.hi)}</span>{/if}
					{#if tl.bufferPos != null && tl.buffer != null}
						<span class="tl-label tl-top tl-buffer anchor-{anchor(tl.bufferPos)}" style:left="{tl.bufferPos}%">
							{tickLabel(tl.buffer)}
						</span>
						<span class="tl-tick tl-buffer" style:left="{tl.bufferPos}%"></span>
					{/if}
					{#if tl.avgPos != null && tl.avg != null}
						{#if tl.showAvgTop}
							<span class="tl-label tl-top tl-avg anchor-{anchor(tl.avgPos)}" style:left="{tl.avgPos}%">
								{tickLabel(tl.avg)}
							</span>
						{/if}
						<span class="tl-tick tl-avg" style:left="{tl.avgPos}%"></span>
						{#if tl.showAvgBottom}
							<span class="tl-label tl-bottom anchor-{anchor(tl.avgPos)}" style:left="{tl.avgPos}%">Ø Abfahrt</span>
						{/if}
					{/if}
					<span class="tl-label tl-bottom anchor-{anchor(tl.zero)}" style:left="{tl.zero}%">Fahrplan</span>
				</div>
			{/if}
		</section>

		<div class="stats">
			<div class="stat">
				<span class="stat-label">Ø Verspätung</span>
				<span class="stat-value accent">
					{st.delaySeconds != null ? fmtSeconds(st.delaySeconds, true) : '—'}
				</span>
			</div>
			<div class="stat">
				<span class="stat-label">Sicherer Puffer</span>
				<span class="stat-value">
					{st.catchBufferSeconds != null ? fmtSeconds(st.catchBufferSeconds) : '—'}
				</span>
			</div>
		</div>

		<div class="actions">
			<button class="btn btn-outline" type="button" onclick={share}>Teilen</button>
			<button class="btn btn-light" type="button" onclick={goAgain}>Neue Suche</button>
		</div>
	{/if}

	<footer>
		Erstellt von
		<a href="https://jelle.schutter.xyz" target="_blank" rel="noopener noreferrer">Jelle Schutter</a>
		· Daten:
		<a href="https://opentransportdata.swiss" target="_blank" rel="noopener noreferrer">opentransportdata.swiss</a>
	</footer>
</main>

<div class="toast" class:show={toastVisible} role="status">{toastMsg}</div>
