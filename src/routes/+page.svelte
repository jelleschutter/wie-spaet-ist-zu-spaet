<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import StationAutocomplete from '$lib/components/StationAutocomplete.svelte';
	import { rememberStation } from '$lib/recentStations';
	import {
		addDays,
		dayTypeOf,
		holidayName,
		isHoliday,
		isoDate,
		parseIsoDate,
		planner,
		PREVIOUS_DAY_TAIL_CUTOFF,
		TransitError,
		type DayType,
		type DepartureDto,
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

	type QueryMeta = { stationId: string; stationName: string; time: string; date: string };

	const TAGLINE = 'Finde heraus, wie viel Verspätung du dir leisten kannst.';

	/** How many connections one "Früher"/"Später" step shows. */
	const PAGE_SIZE = 5;

	/** How many either side of the current departure "Alternative Verbindungen" opens with. */
	const AROUND_SIZE = 2;

	const DATE_WINDOW_DAYS = 14;

	const MINUTES_PER_DAY = 1440;

	const DATE_FORMAT = new Intl.DateTimeFormat('de-CH', {
		weekday: 'long',
		day: '2-digit',
		month: '2-digit'
	});

	const DAY_MONTH_FORMAT = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit' });

	let screen = $state<'form' | 'select' | 'result' | 'list'>('form');
	let stationName = $state('');
	let stationId = $state<string | null>(null);
	let time = $state('');
	let date = $state(isoDate(new Date()));
	let minDate = $state(isoDate(new Date()));
	let maxDate = $state(isoDate(addDays(new Date(), DATE_WINDOW_DAYS)));
	let serviceDays = $state<DayType[]>([dayTypeOf(new Date())]);
	let delaysReady = $state(false);
	let delayInfo = $state(TAGLINE);
	let statusMsg = $state('');
	let statusError = $state(false);
	let busy = $state(false);
	let selectResults = $state<DepartureDto[]>([]);
	let selectTime = $state('');
	let listResults = $state<DepartureDto[]>([]);
	// Where the shown page begins and ends, in minutes: the anchors the next
	// "Früher"/"Später" pages off. Clock strings can't serve, they wrap at 24:00.
	let listEarliest = $state<number | null>(null);
	let listLatest = $state<number | null>(null);
	// Paging can walk off the queried date, so the shown page carries its own.
	let listDate = $state<string | null>(null);
	let result = $state<DepartureDto | null>(null);
	let resultDayType = $state<DayType | null>(null);
	let queryMeta = $state<QueryMeta | null>(null);
	let toastMsg = $state('');
	let toastVisible = $state(false);

	const dayType = $derived(dayTypeOf(parseIsoDate(date)));
	const selectedHoliday = $derived(holidayName(parseIsoDate(date)));
	const dayUnavailable = $derived(!serviceDays.includes(dayType));

	function pad2(n: number) {
		return String(n).padStart(2, '0');
	}

	function formatDate(iso: string) {
		const day = parseIsoDate(iso);
		if (day.getDay() !== 0 && isHoliday(day)) return `Feiertag, ${DAY_MONTH_FORMAT.format(day)}`;
		return DATE_FORMAT.format(day);
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

	function fmtDuration(abs: number) {
		const m = Math.floor(abs / 60);
		const s = abs % 60;
		if (m > 0 && s > 0) return `${m} Min ${s} Sek`;
		if (m > 0) return `${m} Min`;
		return `${s} Sek`;
	}

	function prettyMode(mode: string) {
		const map: Record<string, string> = {
			RAIL: 'Zug',
			BUS: 'Bus',
			TRAM: 'Tram',
			SUBWAY: 'Metro',
			FERRY: 'Fähre',
			FUNICULAR: 'Standseilbahn',
			CABLE_TRAM: 'Seilbahn',
			AERIAL_LIFT: 'Seilbahn',
			TROLLEYBUS: 'Trolleybus',
			MONORAIL: 'Einschienenbahn'
		};
		return map[mode] ?? mode ?? '';
	}

	/** The modes that run on rails, and so stop at a Gleis rather than a Kante. */
	const TRACK_MODES = new Set(['RAIL', 'SUBWAY', 'FUNICULAR']);

	function platformLabel(mode: string, platform: string | null) {
		return platform ? ` · ${TRACK_MODES.has(mode) ? 'Gleis' : 'Kante'} ${platform}` : '';
	}

	/**
	 * The result hero: how late this departure runs on average, with the buffer
	 * you actually plan around - how late *you* can be - spelled out below it.
	 */
	function heroInfo(dto: DepartureDto) {
		const avg = dto.departure.delaySeconds;
		const buffer = dto.departure.catchBufferSeconds;
		// The number is the average, coloured by what it means for you: a departure
		// that runs late buys you time, one that runs early costs you some.
		const cls = avg == null || avg === 0 ? 'neutral' : avg > 0 ? 'good' : 'bad';
		const note =
			buffer == null
				? delaysReady
					? 'Für diese Verbindung liegen keine Verspätungsdaten vor.'
					: 'Für diesen Fahrplan liegen keine Verspätungsdaten vor.'
				: buffer > 0
					? `Komm weniger als ${fmtDuration(buffer)} zu spät, dann klappt es in 9 von 10 Fällen.`
					: buffer < 0
						? `Sei ${fmtDuration(-buffer)} vor der planmässigen Zeit da, dann klappt es in 9 von 10 Fällen.`
						: 'Sei pünktlich da, dann klappt es in 9 von 10 Fällen.';
		if (avg == null) {
			return { cls, num: '—', label: 'Keine Prognose möglich', note };
		}
		// The label above the number says which way it goes, so the number itself
		// carries no sign - and "0 Sek" reads as a Verspätung like any other.
		if (avg < 0) {
			return {
				cls,
				num: fmtDuration(-avg),
				label: 'Diese Verbindung fährt durchschnittlich zu früh:',
				note
			};
		}
		return { cls, num: fmtDuration(avg), label: 'Die durchschnittliche Verspätung beträgt:', note };
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
			meta = { ...meta, stationId: stopId };
			resultDayType = data.dayType;
			const preselected = pick
				? data.results.find(
						(r) =>
							r.line === pick.line && (pick.dest == null || String(r.destination?.id) === pick.dest)
					)
				: undefined;
			if (preselected) {
				showResult(preselected, meta, data.dayType);
			} else if (data.results.length === 1) {
				showResult(data.results[0], meta, data.dayType);
			} else {
				selectResults = data.results;
				selectTime = data.nextDepartureTime ?? meta.time;
				queryMeta = meta;
				screen = 'select';
			}
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
		if (screen === 'list' && listEarliest != null && listLatest != null && listDate) {
			return { earliest: listEarliest, latest: listLatest, date: listDate };
		}
		const single =
			screen === 'result' ? result : screen === 'select' ? selectResults[0] : null;
		if (!single || !queryMeta) return null;
		return {
			earliest: single.plannedDepartureMinutes,
			latest: single.plannedDepartureMinutes,
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
			screen = 'list';
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
	 * Whether a listed departure is the one the result screen is showing, so a
	 * page of alternatives points out where you currently are in it.
	 */
	function isCurrent(dto: DepartureDto) {
		return (
			result != null &&
			// After a roll the page is a different date, where the same minute is
			// a different departure.
			(screen !== 'list' || listDate === queryMeta?.date) &&
			dto.plannedDepartureMinutes === result.plannedDepartureMinutes &&
			dto.line === result.line &&
			(dto.destination?.id ?? null) === (result.destination?.id ?? null)
		);
	}

	function pick(dto: DepartureDto, paged: boolean) {
		const meta = queryMeta as QueryMeta;
		if (!paged) {
			showResult(dto, meta, resultDayType);
			return;
		}
		// A departure picked off a page is no longer the one the original query
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

	function submit(e: SubmitEvent) {
		e.preventDefault();
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

	function goAgain() {
		replaceState(location.pathname, {});
		result = null;
		selectResults = [];
		listResults = [];
		listEarliest = null;
		listLatest = null;
		listDate = null;
		queryMeta = null;
		statusMsg = '';
		// Keep the station and the date as they were; only the time needs to
		// move forward so "Nochmal" reflects the moment you're clicking it.
		updateTimeToNow();
		refreshDateWindow();
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

	onMount(() => {
		(async () => {
			// Start pulling the stops index in while the form is being filled in.
			planner.prewarm();
			try {
				const meta = await planner.meta();
				delaysReady = (meta.delays?.dayTypes?.length ?? 0) > 0;
				serviceDays = meta.serviceDays?.length ? meta.serviceDays : [dayTypeOf(new Date())];
			} catch {
				serviceDays = [dayTypeOf(new Date())];
				delayInfo = 'Die Fahrplandaten konnten nicht geladen werden.';
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
			stationId = meta.stationId;
			stationName = meta.stationName;
			time = meta.time;
			date = meta.date;
			const line = params.get('line');
			runSearch(meta, line ? { line, dest: params.get('dest') } : undefined);
		})();
	});
</script>

<svelte:head>
	<title>Wie spät ist zu spät?</title>
</svelte:head>

<main>
	<header>
		<h1>⏱️ Wie spät ist zu spät?</h1>
		<p class="sub">{delayInfo}</p>
	</header>

	{#if statusMsg}
		<div class="status" class:error={statusError}>{statusMsg}</div>
	{/if}

	{#if screen === 'form'}
		<form class="card" onsubmit={submit}>
			<StationAutocomplete bind:value={stationName} bind:stationId />
			<div class="field">
				<label for="time">Abfahrtszeit</label>
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
				{#if selectedHoliday}
					<p class="sub">{selectedHoliday} — es gilt der Sonntagsfahrplan.</p>
				{:else if dayUnavailable}
					<p class="sub">Für {DAY_TYPE_LABELS[dayType]} liegen keine Fahrplandaten vor.</p>
				{/if}
			</div>
			<button class="go" type="submit" disabled={busy}>Berechnen</button>
		</form>
	{/if}

	{#snippet departureList(items: DepartureDto[], paged: boolean)}
		<div class="select-list">
			{#each items as r (r.plannedDepartureMinutes + ':' + r.line + ':' + (r.destination?.id ?? ''))}
				{@const current = isCurrent(r)}
				<button
					type="button"
					class="select-item"
					class:current
					aria-current={current ? 'true' : undefined}
					onclick={() => pick(r, paged)}
				>
					{#if paged}
						<span class="select-time">{r.plannedDeparture}</span>
					{/if}
					<span class="badge mode-{r.mode || 'OTHER'}">{r.line}</span>
					<span class="select-body">
						<span class="select-dest">→ {r.destination?.name ?? '?'}</span>
						<span class="select-meta">{prettyMode(r.mode)}{platformLabel(r.mode, r.from.platform)}</span>
					</span>
				</button>
			{/each}
		</div>
	{/snippet}

	{#snippet alternativesButton()}
		<button class="pager" type="button" onclick={showAlternatives} disabled={busy}>
			Alternative Verbindungen
		</button>
	{/snippet}

	{#if screen === 'select'}
		<div class="card">
			<h2>Mehrere Abfahrten um {selectTime} Uhr</h2>
			<p class="sub">Welche Verbindung nimmst du?</p>
			{@render departureList(selectResults, false)}
			{@render alternativesButton()}
		</div>
	{/if}

	{#if screen === 'list' && listResults.length}
		<div class="card">
			<h2>Verbindungen ab {queryMeta?.stationName || 'der Haltestelle'}</h2>
			<p class="sub">
				{listResults[0].plannedDeparture} – {listResults[listResults.length - 1]
					.plannedDeparture} Uhr{#if listDate ?? queryMeta?.date}, {formatDate(
						(listDate ?? queryMeta?.date) as string
					)}{:else if resultDayType}, {DAY_TYPE_LABELS[resultDayType]}{/if}
			</p>
			<button class="pager" type="button" onclick={goEarlier} disabled={busy}>↑ Früher</button>
			{@render departureList(listResults, true)}
			<button class="pager" type="button" onclick={goLater} disabled={busy}>↓ Später</button>
		</div>
	{/if}

	{#if screen === 'result' && result}
		{@const b = heroInfo(result)}
		<div class="card">
			<div class="hero">
				<div class="hero-label">{b.label}</div>
				<div class="hero-num {b.cls}">{b.num}</div>
				<div class="hero-note">{b.note}</div>
			</div>
			<div class="detail">
				<span class="badge mode-{result.mode || 'OTHER'}">{result.line}</span>
				<span class="detail-body">
					<span class="detail-dest">{result.plannedDeparture} → {result.destination?.name ?? '?'}</span>
					<span class="detail-meta">
						{prettyMode(result.mode)}{platformLabel(result.mode, result.from.platform)}
						{#if queryMeta}
							· {formatDate(queryMeta.date)}
						{:else if resultDayType}
							· {DAY_TYPE_LABELS[resultDayType]}
						{/if}
					</span>
				</span>
			</div>
			{@render alternativesButton()}
			<div class="actions">
				<button class="secondary" type="button" onclick={share}>Teilen</button>
				<button class="go" type="button" onclick={goAgain}>Nochmal</button>
			</div>
		</div>
	{/if}

	<footer>
		Erstellt von
		<a href="https://jelle.schutter.xyz" target="_blank" rel="noopener noreferrer">Jelle Schutter</a>
		mit Daten von
		<a href="https://opentransportdata.swiss" target="_blank" rel="noopener noreferrer">opentransportdata.swiss</a>
		❤️
	</footer>
</main>

<div class="toast" class:show={toastVisible}>{toastMsg}</div>
