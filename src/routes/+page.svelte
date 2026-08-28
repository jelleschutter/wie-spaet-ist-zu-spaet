<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import StationAutocomplete from '$lib/components/StationAutocomplete.svelte';
	import {
		dayTypeOf,
		holidayName,
		planner,
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

	type QueryMeta = { stationId: string; stationName: string; time: string; dayType: DayType };

	const TAGLINE = 'Finde heraus, wie viel Verspätung du dir leisten kannst.';

	/** How many connections one "Früher"/"Später" step shows. */
	const PAGE_SIZE = 5;

	/** How many either side of the current departure "Alternative Verbindungen" opens with. */
	const AROUND_SIZE = 2;

	// Nationwide holidays run the Sunday timetable, so the day type defaults to
	// Sonntag on one - worth saying out loud rather than looking like a bug.
	const todaysHoliday = holidayName(new Date());

	let screen = $state<'form' | 'select' | 'result' | 'list'>('form');
	let stationName = $state('');
	let stationId = $state<string | null>(null);
	let time = $state('');
	let dayType = $state<DayType>(dayTypeOf(new Date()));
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
	let result = $state<DepartureDto | null>(null);
	let resultDayType = $state<DayType | null>(null);
	let queryMeta = $state<QueryMeta | null>(null);
	let toastMsg = $state('');
	let toastVisible = $state(false);

	function pad2(n: number) {
		return String(n).padStart(2, '0');
	}

	function updateTimeToNow() {
		const now = new Date();
		time = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
	}

	function resetDefaults() {
		updateTimeToNow();
		const today = dayTypeOf(new Date());
		dayType = serviceDays.includes(today) ? today : (serviceDays[0] ?? today);
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

	function platformLabel(platform: string | null) {
		return platform ? ' · Perron ' + platform : '';
	}

	/**
	 * The result hero: how late this departure runs on average, with the buffer
	 * you actually plan around - how late *you* can be - spelled out below it.
	 */
	function heroInfo(dto: DepartureDto) {
		const avg = dto.departure.delaySeconds;
		const buffer = dto.departure.catchBufferSeconds;
		// The colour follows the buffer rather than the average, since that's what
		// the note answers: whether this departure leaves you any room at all.
		const cls = buffer == null || buffer === 0 ? 'neutral' : buffer > 0 ? 'good' : 'bad';
		const note =
			buffer == null
				? delaysReady
					? 'Für diese Verbindung liegen keine Verspätungsdaten vor.'
					: 'Für diesen Fahrplan liegen keine Verspätungsdaten vor.'
				: buffer > 0
					? `Wenn du ${fmtDuration(buffer)} zu spät kommst, schaffst du es in 9 von 10 Fällen.`
					: buffer < 0
						? `Diese Verbindung kann früher abfahren — sei ${fmtDuration(-buffer)} vor der planmässigen Zeit da, um sie in 9 von 10 Fällen zu erwischen.`
						: 'Nur wenn du pünktlich da bist, schaffst du es in 9 von 10 Fällen.';
		if (avg == null) {
			return { cls, num: '—', label: 'keine Prognose möglich', note };
		}
		if (avg > 0) {
			return { cls, num: '+' + fmtDuration(avg), label: 'durchschnittliche Verspätung', note };
		}
		if (avg < 0) {
			return { cls, num: '−' + fmtDuration(-avg), label: 'fährt durchschnittlich zu früh', note };
		}
		return { cls, num: '0 Sek', label: 'fährt im Schnitt pünktlich', note };
	}

	function buildShareUrl(dto: DepartureDto, meta: QueryMeta): URL {
		const params = new URLSearchParams();
		params.set('station', meta.stationId);
		params.set('stationName', meta.stationName);
		params.set('time', meta.time);
		params.set('dayType', meta.dayType);
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
		// The first lookup of a day type pulls in its timetable (a few MB), which
		// takes noticeably longer than the search itself — say so.
		statusMsg = planner.isReady(meta.dayType) ? 'Suche läuft …' : 'Fahrplandaten werden geladen …';
		statusError = false;
		try {
			const data = await planner.getDepartures({
				from: meta.stationId,
				time: meta.time,
				dayType: meta.dayType
			});
			if (!data.results.length) {
				statusMsg = `Keine weiteren Abfahrten ab ${meta.stationName || meta.stationId} nach ${meta.time} Uhr an diesem Tag.`;
				statusError = true;
				return;
			}
			statusMsg = '';
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
	function shownWindow(): { earliest: number; latest: number } | null {
		if (screen === 'list' && listEarliest != null && listLatest != null) {
			return { earliest: listEarliest, latest: listLatest };
		}
		const single =
			screen === 'result' ? result : screen === 'select' ? selectResults[0] : null;
		if (!single) return null;
		return {
			earliest: single.plannedDepartureMinutes,
			latest: single.plannedDepartureMinutes
		};
	}

	async function showPage(direction: Direction, at: number, limit: number) {
		if (!queryMeta) return;
		busy = true;
		statusMsg = '';
		statusError = false;
		try {
			const data = await planner.getDepartureList({
				from: queryMeta.stationId,
				at,
				dayType: queryMeta.dayType,
				direction,
				limit
			});
			if (!data.results.length) {
				statusMsg =
					direction === 'earlier'
						? 'Keine früheren Abfahrten an diesem Tag.'
						: 'Keine späteren Abfahrten an diesem Tag.';
				statusError = true;
				return;
			}
			listResults = data.results;
			listEarliest = data.earliest;
			listLatest = data.latest;
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
		if (window) showPage('earlier', window.earliest, PAGE_SIZE);
	}

	function goLater() {
		// A page always holds whole minutes, so starting one minute past the last
		// one shown skips exactly what's already on screen.
		const window = shownWindow();
		if (window) showPage('later', window.latest + 1, PAGE_SIZE);
	}

	function showAlternatives() {
		const window = shownWindow();
		if (window) showPage('around', window.earliest, AROUND_SIZE);
	}

	/**
	 * Whether a listed departure is the one the result screen is showing, so a
	 * page of alternatives points out where you currently are in it.
	 */
	function isCurrent(dto: DepartureDto) {
		return (
			result != null &&
			dto.plannedDepartureMinutes === result.plannedDepartureMinutes &&
			dto.line === result.line &&
			(dto.destination?.id ?? null) === (result.destination?.id ?? null)
		);
	}

	function pick(dto: DepartureDto, paged: boolean) {
		const meta = queryMeta as QueryMeta;
		// A departure picked off a page is no longer the one the original query
		// asked for, so the shared link has to point at its time instead.
		showResult(dto, paged ? { ...meta, time: dto.plannedDeparture } : meta, resultDayType);
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const id = stationId ?? stationName.trim();
		if (!id) {
			statusMsg = 'Bitte gib einen Abfahrtsort ein.';
			statusError = true;
			return;
		}
		runSearch({ stationId: id, stationName, time, dayType });
	}

	function goAgain() {
		replaceState(location.pathname, {});
		result = null;
		selectResults = [];
		listResults = [];
		listEarliest = null;
		listLatest = null;
		queryMeta = null;
		statusMsg = '';
		// Keep the station and day type as they were; only the time needs to
		// move forward so "Nochmal" reflects the moment you're clicking it.
		updateTimeToNow();
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
				dayType: (params.get('dayType') as DayType) || dayType
			};
			stationId = meta.stationId;
			stationName = meta.stationName;
			time = meta.time;
			if (serviceDays.includes(meta.dayType)) dayType = meta.dayType;
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
				<label for="dayType">Wochentag</label>
				<select id="dayType" bind:value={dayType}>
					{#each serviceDays as t (t)}
						<option value={t}>{DAY_TYPE_LABELS[t]}</option>
					{/each}
				</select>
				{#if todaysHoliday}
					<p class="sub">Heute ist {todaysHoliday} — es gilt der Sonntagsfahrplan.</p>
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
						<span class="select-meta">{prettyMode(r.mode)}{platformLabel(r.from.platform)}</span>
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
					.plannedDeparture} Uhr{#if resultDayType}, {DAY_TYPE_LABELS[resultDayType]}{/if}
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
				<div class="hero-num {b.cls}">{b.num}</div>
				<div class="hero-label">{b.label}</div>
				<div class="hero-note">{b.note}</div>
			</div>
			<div class="detail">
				<span class="badge mode-{result.mode || 'OTHER'}">{result.line}</span>
				<span class="detail-body">
					<span class="detail-dest">{result.plannedDeparture} → {result.destination?.name ?? '?'}</span>
					<span class="detail-meta">
						{prettyMode(result.mode)}{platformLabel(result.from.platform)}
						{#if resultDayType}
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
		&nbsp;·&nbsp;
		Daten von <a href="https://opentransportdata.swiss" target="_blank" rel="noopener noreferrer">Open Transport Data</a>
	</footer>
</main>

<div class="toast" class:show={toastVisible}>{toastMsg}</div>
