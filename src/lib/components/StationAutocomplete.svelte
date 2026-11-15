<script lang="ts">
	import { pushState } from '$app/navigation';
	import { planner } from '$lib/transit';
	import { recentStations, type RecentStation } from '$lib/recentStations';

	type Suggestion = {
		id: number;
		sourceStopId: string | null;
		name: string;
		locationType: string;
		platform: string | null;
	};

	/**
	 * What a picked station is searched and remembered by. The source stop id is
	 * the feed's own, so it still points at the same station after a data:build;
	 * the internal id is a position in stops.txt and only stands in when a stop
	 * carries no source id at all.
	 */
	function stopKey(s: Suggestion): string {
		return s.sourceStopId ?? String(s.id);
	}

	let {
		value = $bindable(''),
		stationId = $bindable<string | null>(null)
	}: { value: string; stationId: string | null } = $props();

	let suggestions = $state<Suggestion[]>([]);
	let sheetOpen = $state(false);
	let sheetEl = $state<HTMLElement>();
	let inputEl = $state<HTMLInputElement>();
	let listEl = $state<HTMLElement>();
	let debounceTimer: ReturnType<typeof setTimeout>;
	let query = $state('');
	let locating = $state(false);
	let locateError = $state('');

	// Read once: the form is torn down while a result is showing, so a search
	// made in between is picked up when this comes back.
	const recents = recentStations();

	/** The recent stations still worth offering for what's been typed so far. */
	const matchingRecents = $derived(
		recents.filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase()))
	);

	// A station offered as a recent shouldn't show up a second time below it.
	const matchingSuggestions = $derived(
		suggestions.filter((s) => !matchingRecents.some((r) => r.id === stopKey(s)))
	);

	async function search(q: string) {
		if (q.trim().length < 2) {
			suggestions = [];
			return;
		}
		try {
			const results = await planner.searchStations({ q, limit: 12 });
			// A slower earlier lookup must not overwrite a newer query's results.
			if (q !== query) return;
			suggestions = results;
		} catch {
			/* stops index still loading or unavailable — keep what is shown */
		}
	}

	function onInput() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => search(query), 150);
	}

	// The picker is a full-screen sheet and a history entry of its own, so the
	// system back gesture closes it instead of leaving the page.
	function openSheet() {
		query = '';
		suggestions = [];
		locateError = '';
		if (sheetEl) sheetEl.inert = false;
		sheetOpen = true;
		// Focus inside the tap itself, or iOS won't raise the keyboard.
		inputEl?.focus({ preventScroll: true });
		pushState(location.href, {});
	}

	function closeSheet() {
		if (sheetOpen) history.back();
	}

	function onPopState() {
		if (sheetOpen) {
			sheetOpen = false;
			inputEl?.blur();
		}
	}

	function done() {
		// Picked something: dismiss the sheet (which pops its history entry).
		closeSheet();
	}

	function pick(s: Suggestion) {
		value = s.name;
		stationId = stopKey(s);
		done();
	}

	function pickRecent(r: RecentStation) {
		value = r.name;
		stationId = r.id;
		done();
	}

	function onEnter(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (matchingRecents[0]) pickRecent(matchingRecents[0]);
			else if (matchingSuggestions[0]) pick(matchingSuggestions[0]);
		} else if (e.key === 'Escape') {
			closeSheet();
		}
	}

	$effect(() => {
		if (sheetEl) sheetEl.inert = !sheetOpen;
	});

	$effect(() => {
		// New results start at the top of the list.
		void query;
		listEl?.scrollTo({ top: 0 });
	});

	function useMyLocation() {
		locateError = '';
		if (!navigator.geolocation) {
			locateError = 'Dieses Gerät unterstützt keine Standortabfrage.';
			return;
		}
		// Browsers (especially Safari) refuse geolocation on insecure origins
		// without ever showing the permission prompt, which otherwise looks
		// identical to the user having denied access.
		if (!window.isSecureContext) {
			locateError = 'Die Standortabfrage funktioniert nur über eine sichere (https://) Verbindung.';
			return;
		}
		locating = true;
		navigator.geolocation.getCurrentPosition(
			async (pos) => {
				try {
					const { latitude, longitude } = pos.coords;
					const nearest = (
						await planner.searchStations({ lat: latitude, lon: longitude, limit: 1 })
					)[0];
					if (nearest) {
						value = nearest.name;
						stationId = stopKey(nearest);
						done();
					} else {
						locateError = 'In der Nähe wurde keine Haltestelle gefunden.';
					}
				} catch {
					locateError = 'Haltestelle konnte nicht ermittelt werden.';
				} finally {
					locating = false;
				}
			},
			(err) => {
				locating = false;
				locateError =
					err.code === err.PERMISSION_DENIED
						? 'Standortzugriff wurde verweigert.'
						: err.code === err.TIMEOUT
							? 'Standortabfrage hat zu lange gedauert.'
							: 'Standort konnte nicht ermittelt werden.';
			},
			{ timeout: 10000, maximumAge: 60000 }
		);
	}

	const LOCATION_TYPE_LABELS: Record<string, string> = {
		STATION: 'Haltestelle',
		SIMPLE_STOP_OR_PLATFORM: 'Haltestelle',
		ENTRANCE_EXIT: 'Eingang',
		GENERIC_NODE: 'Knotenpunkt',
		BOARDING_AREA: 'Einstiegsbereich'
	};

	function meta(s: Suggestion) {
		if (s.platform) return 'Perron ' + s.platform;
		return LOCATION_TYPE_LABELS[s.locationType] ?? 'Haltestelle';
	}
</script>

<svelte:window onpopstate={onPopState} />

<div class="field">
	<button type="button" class="station-field" onclick={openSheet} aria-haspopup="dialog">
		<svg class="sf-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
			<circle cx="11" cy="11" r="7"></circle>
			<path d="m20 20-3.5-3.5"></path>
		</svg>
		<span class="sf-text">
			<span class="sf-label">Haltestelle</span>
			<span class="sf-value" class:placeholder={!value}>{value || 'Haltestelle suchen'}</span>
		</span>
	</button>
</div>

<div class="sheet" class:open={sheetOpen} bind:this={sheetEl} role="dialog" aria-modal="true" aria-label="Haltestelle suchen">
	<div class="sheet-bar">
		<button type="button" class="sheet-back" onclick={closeSheet} aria-label="Schliessen">
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M19 12H5M12 19l-7-7 7-7"></path>
			</svg>
		</button>
		<div class="sheet-input">
			<input
				type="search"
				enterkeyhint="go"
				placeholder="Haltestelle suchen"
				autocomplete="off"
				autocapitalize="words"
				spellcheck="false"
				bind:this={inputEl}
				bind:value={query}
				oninput={onInput}
				onkeydown={onEnter}
			/>
			{#if query}
				<button type="button" class="sheet-clear" aria-label="Eingabe löschen" onclick={() => { query = ''; suggestions = []; inputEl?.focus(); }}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>
				</button>
			{/if}
		</div>
	</div>

	<div class="sheet-list" bind:this={listEl}>
		{#if !query.trim()}
			<button type="button" class="sheet-row" class:locating onclick={useMyLocation} disabled={locating}>
				<span class="sr-icon accent">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
						<circle cx="12" cy="12" r="3"></circle>
						<circle cx="12" cy="12" r="7"></circle>
						<path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path>
					</svg>
				</span>
				<span class="sr-text">
					<span class="sr-name">{locating ? 'Standort wird ermittelt …' : 'Aktueller Standort'}</span>
				</span>
			</button>
			{#if locateError}
				<p class="locate-error">{locateError}</p>
			{/if}
		{/if}

		{#if matchingRecents.length}
			<h2 class="sheet-heading">Zuletzt gesucht</h2>
			{#each matchingRecents as r (r.id)}
				<button type="button" class="sheet-row" onclick={() => pickRecent(r)}>
					<span class="sr-icon">
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="9"></circle>
							<path d="M12 7v5l3 2"></path>
						</svg>
					</span>
					<span class="sr-text"><span class="sr-name">{r.name}</span></span>
				</button>
			{/each}
		{/if}

		{#if matchingSuggestions.length}
			{#if query.trim()}<h2 class="sheet-heading">Haltestellen</h2>{/if}
			{#each matchingSuggestions as s (s.id)}
				<button type="button" class="sheet-row" onclick={() => pick(s)}>
					<span class="sr-icon">
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z"></path>
							<circle cx="12" cy="10" r="2.5"></circle>
						</svg>
					</span>
					<span class="sr-text">
						<span class="sr-name">{s.name}</span>
						<span class="sr-meta">{meta(s)}</span>
					</span>
				</button>
			{/each}
		{:else if query.trim().length >= 2 && !matchingRecents.length}
			<p class="sheet-empty">Keine Haltestelle gefunden</p>
		{/if}
	</div>
</div>
