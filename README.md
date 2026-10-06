# Wie spät ist zu spät?

Finde heraus, wie viel Verspätung du dir leisten kannst: für die nächste Abfahrt
an einer Haltestelle zeigt die Seite, wie lange nach der planmässigen Abfahrtszeit
du noch eintreffen kannst und den Kurs in etwa 9 von 10 Fällen trotzdem erwischst.

Die App läuft **vollständig im Browser** — [minotor](https://minotor.dev) liest den
Fahrplan clientseitig, die Verspätungsstatistik liegt als vorberechnete Binärdaten
daneben. Es gibt keinen Backend-Code und keine API: `npm run build` erzeugt einen
Ordner statischer Dateien, den GitHub Pages (oder jeder andere Static-Host)
ausliefern kann.

## Datenpipeline

Alles, was vor dem Deployment läuft, ist **Node ohne Abhängigkeiten** — die
Standardbibliothek bringt alles mit, was die Pipeline braucht (`node:zlib` liefert
zstd und gzip, ein knappes ZIP-Modul in `pipeline/zip.js` liest die Archive):

```sh
npm run data:build          # = node pipeline/build.js
```

Drei Schritte, jeder einzeln aufrufbar (`--only`) und jeder fortsetzbar:

| Schritt | Quelle | Ergebnis | Dauer |
| --- | --- | --- | --- |
| `download` | [geops GTFS](https://gtfs.geops.ch/dl/gtfs_complete.zip) (165 MB) und 12 Monats­archive [Ist-Daten](https://archive.opentransportdata.swiss/istdaten/) (je ~1.3 GB) | `data/raw/` | ~10 min |
| `timetables` | GTFS | `stops.bin.gz` + 7× `timetable.<wochentag>.bin.gz` + 7× `tail.<wochentag>.bin.gz` | ~9 min pro Wochentag |
| `delays` | Ist-Daten | `delays/<wochentag \| gruppe>/<n>.bin.gz` | ~2 s pro Kalendertag, 12 Monate in ~18 min |

Nützliche Flags: `--days 3` (nur drei Ist-Daten-Tage, für einen schnellen
Durchlauf), `--months 1`, `--only delays`, `--force`, `--today 2026-08-17`,
`--heap MB`, `--prune` (jedes Monatsarchiv erst kurz vor dem Lesen holen und
danach wieder löschen — hält den Spitzenplatzbedarf bei einem Monat statt ~16 GB,
dafür lädt der nächste Lauf erneut herunter; CI baut damit).

### Wie viel Arbeitsspeicher der Fahrplan braucht

`timetables` ist der einzige speicherhungrige Schritt: minotors `parse-gtfs` hält
jedes Routenmuster des Feeds gleichzeitig im Speicher und kommt damit auf rund
**1.4 GB** Spitzenverbrauch pro Lauf. Der Heap-Deckel wird deshalb aus dem RAM der
Maschine abgeleitet (höchstens 4 GB, `--heap MB` überschreibt ihn) — ein pauschal
grosser Deckel würde nichts verbessern: V8 räumt erst dann richtig auf, wenn es an
sein Limit stösst, und auf einer kleinen Maschine kommt der Kernel vorher.

Unter ~3 GB RAM warnt der Build. Ohne Swap beendet der Kernel den Parser dort
mitten im Lauf mit SIGKILL, und das sieht nach einem Parser-Fehler aus, ist aber
keiner: Die `Missing arrival or departure time`-Zeilen davor sind normal — das
Feed enthält ~38 000 Halte ohne Zeiten, die übersprungen werden. Sie stehen
vollständig in `data/work/parse-gtfs.<wochentag>.warnings.log`, der Fortschritt
daneben in `parse-gtfs.<wochentag>.log`.

### Fahrplan: ein Datum pro Wochentag

Die App beantwortet „was fährt als nächstes“, deshalb steht für jeden Wochentag
das Datum, das **heute am nächsten liegt** — heute selbst für den heutigen
Wochentag, sonst höchstens drei Tage entfernt. Damit bleibt jeder Fahrplan im
Fenster der letzten und der nächsten sieben Tage und beschreibt den aktuellen
Betrieb statt einer beliebigen Woche des Jahresfahrplans. Feiertage werden dabei
übersprungen (siehe unten).

### Liniennamen: `RE12` statt `RE`

minotor übernimmt als Liniennamen nur `route_short_name`, und dort steht bei
vielen Regionalzügen bloss die Kategorie: `RE`, `R`. Die Nummer steht in
`route_long_name` (`RE 12`) — und die Ist-Daten nennen denselben Zug `RE12`,
wie die Anzeige am Perron. Bevor minotor den Feed liest, schreibt `namedFeed()`
deshalb eine Kopie (`data/work/gtfs_named.zip`), in deren `routes.txt` solche
Linien ihren vollen Namen tragen: bei R, RE, S, SN, IR, PE und CC, wenn der
lange Name genau Kategorie und eine höchstens dreistellige Nummer ist, mit oder
ohne Leerzeichen — manche Betreiber schreiben dieselbe Linie beidemal (16 993 von
874 823 Routen). Bei EC, IC oder ICE ist diese Nummer eine
Zugnummer, und die Ist-Daten führen dort nur die Kategorie. Alle anderen Dateien
des ZIPs bleiben Byte für Byte, wie sie sind — `stop_times.txt` wird nicht neu
komprimiert.

### Nach Mitternacht: nur der Rest des Vortags

Ein Kurs gehört zum Betriebstag, an dem er losfährt: was am Dienstag um 00:30
abfährt, steht meist im Montagsfahrplan, um 24:30. Eine Abfrage vor 6 Uhr liest
deshalb auch den Vortag, braucht davon aber nur die Kurse nach Mitternacht.
`pipeline/tail.js` schreibt darum zu jedem Wochentag
`tail.<wochentag>.bin.gz`: nur die Kurse, die nach Mitternacht noch abfahren,
ganz und mit unveränderten Zeiten. Für den Vortag lädt der Browser diese Datei
statt des ganzen Fahrplans. Das sind rund 3 500 Kurse (in den Nächten auf
Samstag und Sonntag gut 7 000) und 0.2–0.4 MB statt 5–8 MB; eine Abfrage vor
6 Uhr braucht damit kaum mehr Speicher als eine tagsüber.

Eine eigene Datei, statt die Kurse in den Fahrplan des Folgetags zu schreiben,
weil erst der Browser weiss, welcher Tag davorliegt: nach einem Feiertag fahren
die Nachtkurse des Sonntagsfahrplans, nicht die des Wochentags.

### Verspätungen: warum vorberechnet

Zwölf Monate Ist-Daten sind ~16 GB gezippt und entpacken zu rund 213 GB — ein
CSV pro Kalendertag mit je ~2.4 Mio. Halt-Ereignissen. Für die eigentliche Frage
braucht es pro geplanter Abfahrt aber nur sechs Zahlen. Deshalb:

1. **pro Tag** wird das CSV direkt aus dem ZIP gestreamt und auf `(BPUIC, Linie,
   Planminute, Tagesoffset, Verspätung)` reduziert — nur echte Abfahrten, ohne
   Ausfälle, Durchfahrten und Zusatzfahrten. Der Parser liest Bytes statt Strings:
   für die ~12 Spalten, die wieder wegfliegen, wird nichts dekodiert, gesplittet
   oder alloziert. Ergebnis ist eine kleine zstd-Datei je Kalendertag;
2. **pro Wochentag** werden dessen ~52 Tagesdateien zu einer Zeile je Kurs
   aggregiert: Anzahl Messungen, Durchschnitt und Verspätungspuffer. Das läuft in
   vier Durchgängen über `bpuic % 4` (`--chunks`), weil der exakte Perzentilwert
   alle Messungen einer Gruppe gleichzeitig im Speicher braucht — ein Wochentag
   sind ~117 Mio. Zeilen;
3. jede Zeile wird zu **10 Bytes** und nach Haltestelle in 1024 Shards pro
   Wochentag gruppiert, gzip-komprimiert.

Ergebnis: eine Abfrage lädt pro Auswertung einen Shard (~20 KB) statt des Datensatzes.

### Gruppen: Mo–Fr, Wochenende, alle Tage

Neben dem einzelnen Wochentag kann man in der App wählen, aus welchen Tagen die
Zahlen stammen: dem gleichen Wochentag („Montags“), Mo–Fr bzw. dem Wochenende
(Sa, So und Feiertage) oder allen Tagen. Standard ist Mo–Fr bzw. das
Wochenende — ein Vielfaches an Messungen für Kurse, die die ganze Woche gleich
fahren. Ein Perzentil lässt sich nicht aus den Werten der einzelnen Wochentage
zusammensetzen, deshalb aggregiert Schritt 2 jede Gruppe noch einmal aus den
Tagesdateien und schreibt sie wie einen Wochentag nach `delays/weekdays/`,
`delays/weekend/` und `delays/all/`. Eine Gruppe läuft in `--chunks` Durchgängen
pro enthaltenem Wochentag, braucht also nicht mehr Speicher als ein einzelner
Wochentag, nur mehr Zeit. Der Browser lädt alle drei Shards einer Haltestelle
auf einmal, der Wechsel zwischen den Auswertungen braucht dann keine neue
Abfrage. Ein Bündel ohne Gruppen (älter als dieser Schritt) funktioniert
weiterhin; die Auswahl fehlt dann einfach.

Der **Verspätungspuffer** ist der grösste Wert B, bei dem der Kurs an mindestens
90 % der gemessenen Tage um B oder mehr verspätet abgefahren ist — komm B
Sekunden nach der Planzeit und du erwischst ihn in etwa 9 von 10 Fällen. Das ist
die k-kleinste beobachtete Verspätung mit k = n / 10 (abgerundet), also *nearest
rank* und nicht interpoliert: ein interpolierendes Perzentil würde zwischen zwei
Messungen einen Wert erfinden, den die Daten bei wenigen Messungen nicht stützen
(bei den Werten −30 s und +150 s käme −12 s heraus, was auf 1 von 2 Tagen
zutrifft, nicht auf 90 %). Ein negativer Puffer heisst: sei entsprechend früher
da.

Erscheint ein Kurs unter mehreren Tagesoffsets, gewinnt der besser belegte; bei
gleichem Stand der Offset, der näher am Betriebstag liegt. Diese zweite Regel gibt
es, damit die Ausgabe nicht von der Lesereihenfolge abhängt.

Der Join läuft über die **BPUIC**: die GTFS-Haltestellen-IDs sind
`<bpuic>[:<perron>]`, und die Ist-Daten führen dieselbe Nummer. Der Browser
braucht dafür nur die Zahl vor dem Doppelpunkt — kein SLOID, kein DIDOK-Sidecar.
(Die Ist-Daten mischen 7-stellige Haltestellen- und 9-stellige Perron-Nummern;
die Pipeline kürzt auf die ersten sieben Stellen.)

Innerhalb der Haltestelle zählen Linie und Planminute. Weil die Ist-Daten je nach
Betreiber `RE12` oder nur `RE` schreiben, sucht der Browser zuerst den Namen aus
dem Fahrplan und danach die andere Form: `RE12` als `RE`, oder ein `RE` (aus
einem Fahrplan ohne volle Namen) als die eine nummerierte RE-Linie dieser
Minute. Die zweite Suche zählt nur, wenn keine andere Abfahrt derselben Minute
die Zeile für sich beanspruchen könnte.

### Feiertage gelten als Sonntag

An den landesweiten Feiertagen fährt der Sonntagsfahrplan. Neujahr,
Berchtoldstag, Karfreitag, Ostermontag, Auffahrt, Pfingstmontag, Bundesfeier,
Weihnachten und Stephanstag werden deshalb sowohl bei der Aggregation als auch bei
der Abfrage als Sonntag behandelt. Die Pipeline importiert dafür direkt
`src/lib/transit/holidays.ts` (Node 24 entfernt die Typen beim Laden selbst), es
gibt also keine zweite Liste, die abweichen könnte.

## Aufbau

```
pipeline/                 Node-Pipeline, nur Standardbibliothek
  build.js                Orchestrierung + CLI
  download.js             GTFS und Ist-Daten holen (resumable)
  timetables.js           minotor-CLI pro Wochentag aufrufen
  tail.js                 die Kurse nach Mitternacht aus einem Fahrplan schneiden
  delays.js               Ist-Daten aggregieren und Shards schreiben
  zip.js                  ZIP lesen (Central Directory, ZIP64, streamend)
  layout.js               Pfade, Konstanten, Binärformat

data/                     nicht im Git
  raw/                    heruntergeladene Feeds (~16 GB)
  work/                   Tagesdateien (zstd), entpackte .bin-Dateien, Feed mit vollen Liniennamen

static/data/              ausgeliefertes Bündel (nicht im Git, 215 MB, 7184 Dateien)
  stops.bin.gz            1.6 MB
  timetable.<tag>.bin.gz  5.4 MB (So) bis 8.5 MB (Fr), zusammen 54 MB
  tail.<tag>.bin.gz       Kurse nach Mitternacht, 0.2 MB bis 0.4 MB (Fr, Sa)
  delays/<tag>/<n>.bin.gz 1024 Shards pro Wochentag, zusammen 158 MB
  delays/<gruppe>/…       dasselbe für weekdays, weekend und all
  meta.json               Wochentage, Abdeckung, globale Linientabelle

src/lib/transit/          die Logik, die früher auf dem Server lief
  planner.ts              Abfahrtstafel für eine Haltestelle (minotor im Browser)
  timetable.ts            minotors Fahrplandatei als flache Arrays lesen
  delays.ts               Verspätungs-Shards laden und Abfahrten zuordnen
  assets.ts               Laden + gzip-Dekomprimierung des Datenbündels
  holidays.ts / time.ts   Feiertage und Zeit-Helfer
```

Was der Browser lädt: `meta.json` (~20 KB) plus den Haltestellen-Index (1.4 MB),
einen Fahrplan (5–8 MB) pro Wochentag, danach ~20 KB pro Haltestelle. Alles
ausser den Fahrplänen bleibt für die Session im Speicher; eine zweite Abfrage am
selben Wochentag dauert ~10 ms. Den Fahrplan liest `timetable.ts` direkt aus
minotors Binärformat in ein paar flache Arrays (23–36 MB), statt über minotors
`Timetable`, das daraus rund 215 000 Objekte mit zusammen über 600 MB macht —
mehr, als Safari auf dem iPhone einem Tab lässt. Der Planner behält trotzdem nur
den Fahrplan, nach dem zuletzt gefragt wurde (vor 6 Uhr zusätzlich die
Nachtkurse des Vortags), und gibt die übrigen frei, bevor der nächste
heruntergeladen wird.

Geladen wird vorab, nicht auf Zuruf: das Inline-Skript in `app.html` startet
`meta.json` und den Haltestellen-Index, während das Dokument noch geparst wird
— also bevor das App-Bundle überhaupt da ist —, und `TransitPlanner.preload()`
hängt den Fahrplan des im Formular gewählten Tages hinten dran, während die
Eingaben noch gemacht werden. Der Reihe nach, nicht gleichzeitig: die
Haltestellensuche kommt zuerst und soll sich die Leitung nicht mit ein paar MB
Fahrplan teilen. Bei einer Abfrage in den frühen Morgenstunden kommen die
Nachtkurse des Vortags dazu, bei gesetztem Data-Saver gar nichts.

Ein Durchlauf über 12 Monate ergibt 26.6 Mio. Kurse (3.2–4.2 Mio. pro
Wochentag) an 24 755 Haltestellen. Der Median liegt bei 20–32 Messungen pro
Kurs — weniger als die 49–61 erfassten Tage, weil der Jahresfahrplanwechsel im
Dezember mitten im Zeitraum liegt. Wer das Bündel kleiner will, wirft mit
`--min-samples 10` die dünn belegten Kurse weg (76 % bleiben, ~121 MB statt
158 MB).

## Entwicklung

```sh
npm install
npm run data:build     # nur nötig, wenn die Daten neu sollen
npm run dev
```

`npm run check` prüft Typen, `npm run build` erzeugt `build/`, `npm run preview`
serviert diesen Ordner lokal.

## Deployment auf GitHub Pages

`.github/workflows/deploy.yml` baut die Seite bei jedem Push auf `main` und
veröffentlicht sie über GitHub Pages (Settings → Pages → Source: *GitHub Actions*).
Der Basispfad wird automatisch gesetzt: `/<repo>` für eine Projekt-Seite,
kein Präfix bei einer User-Seite oder wenn `static/CNAME` existiert. Lokal lässt
sich das mit `BASE_PATH=/wie-spaet-ist-zu-spaet npm run build` nachstellen.

### Die Daten baut CI

**`static/data/` liegt nicht im Git** — 215 MB in 7184 Dateien, und jede
Aktualisierung würde dieselbe Menge noch einmal in die History legen. Stattdessen
erzeugt der Workflow das Bündel selbst, in zwei Jobs, die parallel laufen und
ihre Hälfte getrennt cachen:

| Job | Dauer (kalt) | Cache-Key | rebaut sich |
| --- | --- | --- | --- |
| `timetables` | ~70 min | Kalenderwoche | wöchentlich |
| `delays` | ~50 min, davon die Hälfte Download | Monat | monatlich |

Der langsame Teil ist damit das Fahrplan-Parsen, nicht die Statistik: minotor
braucht pro Wochentag ~9 min, die 213 GB Ist-Daten sind in ~18 min durch.

Die beiden Takte kommen von den Quellen: der GTFS-Feed wird täglich neu gebaut
und „nächste Gelegenheit jedes Wochentags“ wandert mit dem Datum, während die
Ist-Daten als Monatsarchive erscheinen und dazwischen unverändert bleiben. Ein
normaler Push trifft beide Caches und ist in wenigen Minuten deployt; nur der
erste Lauf einer Woche (bzw. eines Monats) zahlt einen Neubau. Der Montags-Cron
sorgt dafür, dass dieser Neubau dort landet statt auf einem Push — und hält beide
Caches innerhalb der 7-Tage-Frist, nach der GitHub sie sonst verwirft.

Der `delays`-Job holt jedes Monatsarchiv einzeln (`--prune`) und löscht es sofort
wieder, sonst würden die 15 GB Rohdaten den Runner sprengen. Sein Monatsfenster
ist vier Tage zurück verankert (`--today`), weil das Archiv eines Monats erst ein
paar Tage nach dessen Ende veröffentlicht wird: der Key springt am 5. um, wenn
der abgeschlossene Monat sicher abrufbar ist.

Jede Hälfte schreibt ihre eigene `meta.json` — der `build`-Job führt beide mit
`jq` zusammen, bevor `npm run build` läuft. Einen Neubau erzwingt man über
*Run workflow* → `rebuild: timetables | delays | everything`.
