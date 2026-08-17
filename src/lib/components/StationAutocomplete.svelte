<script lang="ts">
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

	async function search(q: string) {
		if (q.trim().length < 2) {
			suggestions = [];
			open = false;
			return;
		}
		try {
			const res = await fetch('/api/stations?limit=7&q=' + encodeURIComponent(q));
			const data = await res.json();
			suggestions = data.results ?? [];
			open = suggestions.length > 0;
		} catch {
			/* transient network error — leave the dropdown as-is */
		}
	}

	function onInput() {
		stationId = null; // typing invalidates a prior selection
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => search(value), 180);
	}

	function pick(s: Suggestion) {
		value = s.name;
		stationId = String(s.id);
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
					const res = await fetch(`/api/stations?lat=${latitude}&lon=${longitude}&limit=1`);
					const data = await res.json();
					const nearest = data.results?.[0];
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
		onfocus={() => (open = suggestions.length > 0)}
		onblur={() => setTimeout(() => (open = false), 150)}
	/>
	{#if open}
		<div class="ac">
			{#each suggestions as s (s.id)}
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
