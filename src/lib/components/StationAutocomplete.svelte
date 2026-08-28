<script lang="ts">
	import { planner } from '$lib/transit';
	import { recentStations, type RecentStation } from '$lib/recentStations';

	type Suggestion = {
		id: number;
		name: string;
		locationType: string;
		platform: string | null;
	};

	let {
		value = $bindable(''),
		stationId = $bindable<string | null>(null)
	}: { value: string; stationId: string | null } = $props();

	let suggestions = $state<Suggestion[]>([]);
	let open = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout>;
	let locating = $state(false);
	let locateError = $state('');

	// Read once: the form is torn down while a result is showing, so a search
	// made in between is picked up when this comes back.
	const recents = recentStations();

	/** The recent stations still worth offering for what's been typed so far. */
	const matchingRecents = $derived(
		recents.filter((r) => r.name.toLowerCase().includes(value.trim().toLowerCase()))
	);

	// A station offered as a recent shouldn't show up a second time below it.
	const matchingSuggestions = $derived(
		suggestions.filter((s) => !matchingRecents.some((r) => r.id === String(s.id)))
	);

	const hasItems = $derived(matchingRecents.length > 0 || matchingSuggestions.length > 0);

	async function search(q: string) {
		if (q.trim().length < 2) {
			suggestions = [];
			open = matchingRecents.length > 0;
			return;
		}
		try {
			const results = await planner.searchStations({ q, limit: 7 });
			// A slower earlier lookup must not overwrite a newer query's results.
			if (q !== value) return;
			suggestions = results;
			open = hasItems;
		} catch {
			/* stops index still loading or unavailable — leave the dropdown as-is */
		}
	}

	function onInput() {
		stationId = null; // typing invalidates a prior selection
		// The recents filter on every keystroke; only the stop index lookup waits.
		open = hasItems;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => search(value), 180);
	}

	function pick(s: Suggestion) {
		value = s.name;
		stationId = String(s.id);
		open = false;
	}

	function pickRecent(r: RecentStation) {
		value = r.name;
		stationId = r.id;
		open = false;
	}

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
		open = false;
		navigator.geolocation.getCurrentPosition(
			async (pos) => {
				try {
					const { latitude, longitude } = pos.coords;
					const nearest = (
						await planner.searchStations({ lat: latitude, lon: longitude, limit: 1 })
					)[0];
					if (nearest) {
						value = nearest.name;
						stationId = String(nearest.id);
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

<div class="field">
	<div class="field-head">
		<label for="station">Abfahrtsort</label>
		<button type="button" class="locate-btn" onclick={useMyLocation} disabled={locating}>
			📍 {locating ? 'Suche …' : 'Mein Standort'}
		</button>
	</div>
	<input
		type="text"
		id="station"
		placeholder="z. B. Baden"
		autocomplete="off"
		bind:value
		oninput={onInput}
		onfocus={() => (open = hasItems)}
		onblur={() => setTimeout(() => (open = false), 150)}
	/>
	{#if open}
		<div class="ac">
			{#each matchingRecents as r (r.id)}
				<button type="button" class="ac-item recent" onmousedown={() => pickRecent(r)}>
					<span class="ac-name">{r.name}</span>
					<span class="ac-meta">Zuletzt gesucht</span>
				</button>
			{/each}
			{#each matchingSuggestions as s (s.id)}
				<button type="button" class="ac-item" onmousedown={() => pick(s)}>
					<span class="ac-name">{s.name}</span>
					<span class="ac-meta">{meta(s)}</span>
				</button>
			{/each}
		</div>
	{/if}
	{#if locateError}
		<p class="locate-error">{locateError}</p>
	{/if}
</div>
