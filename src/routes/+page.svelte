<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import StationAutocomplete from '$lib/components/StationAutocomplete.svelte';

	type DayType = 'weekday' | 'saturday' | 'sunday';
	const DAY_TYPE_LABELS: Record<DayType, string> = {
		weekday: 'Werktag',
		saturday: 'Samstag',
		sunday: 'Sonntag'
	};

	type StopDto = { id: number; name: string; platform: string | null };
	type DepartureDto = {
		line: string;
		mode: string;
		from: StopDto;
		destination: StopDto | null;
		plannedDeparture: string;
		departure: { catchBufferSeconds: number | null; samples: number | null };
	};
	type QueryMeta = { stationId: string; stationName: string; time: string; dayType: DayType };

	const TAGLINE = 'Finde heraus, wie viel Verspätung du dir leisten kannst.';

	let screen = $state<'form' | 'select' | 'result'>('form');
	let stationName = $state('');
	let stationId = $state<string | null>(null);
	let time = $state('');
	let dayType = $state<DayType>('weekday');
	let serviceDays = $state<DayType[]>(['weekday']);
	let delaysReady = $state(false);
	let delayInfo = $state(TAGLINE);
	let statusMsg = $state('');
	let statusError = $state(false);
	let busy = $state(false);
	let selectResults = $state<DepartureDto[]>([]);
	let selectTime = $state('');
	let result = $state<DepartureDto | null>(null);
	let resultDayType = $state<DayType | null>(null);
	let queryMeta = $state<QueryMeta | null>(null);
	let toastMsg = $state('');
	let toastVisible = $state(false);

	function pad2(n: number) {
		return String(n).padStart(2, '0');
	}

	function dayTypeOfNow(): DayType {
		const d = new Date().getDay();
		return d === 0 ? 'sunday' : d === 6 ? 'saturday' : 'weekday';
	}

	function updateTimeToNow() {
		const now = new Date();
		time = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
	}

	function resetDefaults() {
		updateTimeToNow();
		const today = dayTypeOfNow();
		dayType = serviceDays.includes(today) ? today : (serviceDays[0] ?? 'weekday');
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

	function bufferInfo(dto: DepartureDto) {
		const sec = dto.departure.catchBufferSeconds;
		if (sec == null) {
			return {
				cls: 'neutral',
				num: '—',
				label: 'keine Prognose möglich',
				note: delaysReady
					? 'Für diese Verbindung liegen noch keine Verspätungsdaten vor.'
					: 'Die Daten werden noch geladen — versuch es gleich nochmal.'
			};
		}
		if (sec > 0) {
			return {
				cls: 'good',
				num: '+' + fmtDuration(sec),
				label: 'Verspätung ist drin',
				note: `Komm bis zu ${fmtDuration(sec)} nach der planmässigen Abfahrt und du schaffst es trotzdem in etwa 9 von 10 Fällen.`
			};
		}
		if (sec < 0) {
			return {
				cls: 'bad',
				num: '−' + fmtDuration(-sec),
				label: 'lieber früher da sein',
				note: `Diese Verbindung kann früher abfahren — sei ${fmtDuration(-sec)} vor der planmässigen Zeit da, um sie in etwa 9 von 10 Fällen zu erwischen.`
			};
		}
		return {
			cls: 'neutral',
			num: '0 Sek',
			label: 'pünktlich da sein',
			note: 'Diese Verbindung fährt normalerweise pünktlich ab.'
		};
	}

	function buildShareUrl(dto: DepartureDto, meta: QueryMeta): URL {
		const url = new URL(location.href);
		url.search = '';
		url.searchParams.set('station', meta.stationId);
		url.searchParams.set('stationName', meta.stationName);
		url.searchParams.set('time', meta.time);
		url.searchParams.set('dayType', meta.dayType);
		url.searchParams.set('line', dto.line);
		if (dto.destination?.id != null) url.searchParams.set('dest', String(dto.destination.id));
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
		statusMsg = 'Suche läuft …';
		statusError = false;
		try {
			const params = new URLSearchParams({ from: meta.stationId, time: meta.time, dayType: meta.dayType });
			const res = await fetch('/api/departures?' + params);
			const data = await res.json();
			if (data.error) {
				statusMsg = data.error;
				statusError = true;
				return;
			}
			if (!data.results.length) {
				statusMsg = `Keine weiteren Abfahrten ab ${meta.stationName || meta.stationId} nach ${meta.time} Uhr an diesem Tag.`;
				statusError = true;
				return;
			}
			statusMsg = '';
			const preselected: DepartureDto | undefined = pick
				? data.results.find(
						(r: DepartureDto) =>
							r.line === pick.line && (pick.dest == null || String(r.destination?.id) === pick.dest)
					)
				: undefined;
			if (preselected) {
				showResult(preselected, meta, data.dayType);
			} else if (data.results.length === 1) {
				showResult(data.results[0], meta, data.dayType);
			} else {
				selectResults = data.results;
				selectTime = data.nextDepartureTime;
				queryMeta = meta;
				screen = 'select';
			}
		} catch (err) {
			statusMsg = 'Anfrage fehlgeschlagen: ' + (err as Error).message;
			statusError = true;
		} finally {
			busy = false;
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
		runSearch({ stationId: id, stationName, time, dayType });
	}

	function goAgain() {
		replaceState(location.pathname, {});
		result = null;
		selectResults = [];
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
			try {
				const res = await fetch('/api/health');
				const h = await res.json();
				const d = h.delays ?? {};
				delaysReady = Boolean(d.ready);
				delayInfo = delaysReady ? TAGLINE : 'Die Daten werden geladen …';
				serviceDays = h.routing?.serviceDays?.length ? h.routing.serviceDays : ['weekday'];
			} catch {
				serviceDays = ['weekday'];
			}
			resetDefaults();

			const params = page.url.searchParams;
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
			</div>
			<button class="go" type="submit" disabled={busy}>Berechnen</button>
		</form>
	{/if}

	{#if screen === 'select'}
		<div class="card">
			<h2>Mehrere Abfahrten um {selectTime} Uhr</h2>
			<p class="sub">Welche Verbindung nimmst du?</p>
			<div class="select-list">
				{#each selectResults as r (r.line + ':' + (r.destination?.id ?? ''))}
					<button
						type="button"
						class="select-item"
						onclick={() => showResult(r, queryMeta as QueryMeta, resultDayType)}
					>
						<span class="badge mode-{r.mode || 'OTHER'}">{r.line}</span>
						<span class="select-body">
							<span class="select-dest">→ {r.destination?.name ?? '?'}</span>
							<span class="select-meta">{prettyMode(r.mode)}{platformLabel(r.from.platform)}</span>
						</span>
					</button>
				{/each}
			</div>
		</div>
	{/if}

	{#if screen === 'result' && result}
		{@const b = bufferInfo(result)}
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
			<div class="actions">
				<button class="secondary" type="button" onclick={share}>Teilen</button>
				<button class="go" type="button" onclick={goAgain}>Nochmal</button>
			</div>
		</div>
	{/if}

	<footer>
		Erstellt von
		<a href="https://jelle.schutter.xyz" target="_blank" rel="noopener noreferrer">Jelle Schutter</a>
	</footer>
</main>

<div class="toast" class:show={toastVisible}>{toastMsg}</div>
