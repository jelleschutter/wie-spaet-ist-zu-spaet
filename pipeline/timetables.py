"""Builds the minotor stops index and one timetable per weekday from the GTFS feed.

This is the one step that shells out to Node: the `.bin` files are minotor's own
protobuf format, and its GTFS parser is what defines them (route patterns, stop
adjacency, trip continuations), so we drive minotor's CLI rather than
reimplementing its serializer in Python.

Two quirks of minotor 11.5.0 shape this:

  * `parse-stops` is unusable - it declares `-s, --outputPath` but reads
    `options.stopsOutputPath`, so it always crashes on an undefined path.
  * `parse-gtfs` writes both a timetable *and* a stops file, and its
    `parseStops()` takes no date, so the stops index is date-independent.

So we run `parse-gtfs` once per weekday and keep the stops file from the first
run. Each run streams the feed's 1.4 GB stop_times.txt and takes ~8 minutes.
"""

from __future__ import annotations

import csv
import datetime as dt
import gzip
import io
import subprocess
import zipfile
from pathlib import Path

from holidays import is_holiday
from layout import DAY_TYPES, OUT_DIR, REPO, WORK_DIR, Timer, die, log, mb

MINOTOR_CLI = REPO / "node_modules" / "minotor" / "dist" / "cli.mjs"

# The geops feed uses standard GTFS route types (0 tram, 2 rail, 3 bus, ...),
# not the extended 100-1799 range, so minotor's `standard` profile is the one
# that maps them onto its own RouteTypes enum.
GTFS_PROFILE = "standard"

# Node's default heap isn't enough for a feed this size.
NODE_HEAP_MB = 8192


def feed_window(gtfs_zip: Path) -> tuple[dt.date, dt.date] | None:
    """The feed's validity window from feed_info.txt, if it declares one."""
    with zipfile.ZipFile(gtfs_zip) as z:
        if "feed_info.txt" not in z.namelist():
            return None
        with z.open("feed_info.txt") as fh:
            row = next(csv.DictReader(io.TextIOWrapper(fh, "utf-8-sig")), None)
    if not row:
        return None
    try:
        start = dt.datetime.strptime(row["feed_start_date"], "%Y%m%d").date()
        end = dt.datetime.strptime(row["feed_end_date"], "%Y%m%d").date()
    except (KeyError, ValueError):
        return None
    return start, end


def timetable_dates(
    today: dt.date, window: tuple[dt.date, dt.date] | None = None
) -> dict[str, dt.date]:
    """One date per weekday, taken from the fortnight around `today`.

    The app answers "what leaves around now", so each weekday is represented by
    its occurrence nearest to today - today itself for today's weekday, and at
    most three days out for the others. That keeps every timetable inside the
    last-7-days/today/next-7-days window and current with the live schedule,
    rather than describing some arbitrary week of the annual feed.

    Nationwide holidays are skipped: they run the Sunday timetable, so taking
    e.g. a 1 August Tuesday as "the Tuesday timetable" would describe the wrong
    service pattern. Sunday is picked the same way, from an ordinary Sunday.
    """
    chosen: dict[str, dt.date] = {}
    for index, day_type in enumerate(DAY_TYPES):
        ahead = (index - today.weekday()) % 7  # 0..6 days forward
        # The same weekday also sits at `ahead - 7`, `ahead + 7`, ... Try them
        # nearest-first: within +/-7 days normally, wider only if holidays force it.
        offsets = sorted(
            (ahead + 7 * k for k in range(-3, 4)),
            key=lambda offset: (abs(offset), offset < 0),
        )
        candidates = [today + dt.timedelta(days=offset) for offset in offsets]
        usable = [
            date
            for date in candidates
            if (window is None or window[0] <= date <= window[1]) and not is_holiday(date)
        ]
        if not usable:  # every nearby date is out of window - fall back to in-window
            usable = [
                date
                for date in candidates
                if window is None or window[0] <= date <= window[1]
            ]
        if not usable:
            die(f"no usable {day_type} within three weeks of {today} inside the feed window.")
        chosen[day_type] = usable[0]
    return chosen


def _stamp_for(gtfs_zip: Path, date: dt.date) -> str:
    stat = gtfs_zip.stat()
    return f"{date.isoformat()}|{stat.st_size}|{int(stat.st_mtime)}|{GTFS_PROFILE}"


def _gzip_to(source: Path, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0 keeps the output byte-identical between runs on unchanged input,
    # so re-generating the bundle doesn't churn git for nothing.
    data = gzip.compress(source.read_bytes(), compresslevel=9, mtime=0)
    dest.write_bytes(data)
    return len(data)


def build(
    gtfs_zip: Path,
    dates: dict[str, dt.date],
    *,
    force: bool = False,
    node: str = "node",
) -> dict[str, str]:
    """Writes stops.bin.gz and timetable.<weekday>.bin.gz; returns the dates used."""
    if not MINOTOR_CLI.exists():
        die(f"minotor CLI not found at {MINOTOR_CLI} - run `npm install` first.")

    window = feed_window(gtfs_zip)
    if window:
        log(f"  feed valid {window[0]} .. {window[1]}")
        outside = [d.isoformat() for d in dates.values() if not window[0] <= d <= window[1]]
        if outside:
            die(f"dates outside the feed's validity window: {', '.join(outside)}")

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # Drop timetables from an earlier run whose day types no longer exist.
    for stale in OUT_DIR.glob("timetable.*.bin.gz"):
        if stale.name[len("timetable.") : -len(".bin.gz")] not in DAY_TYPES:
            log(f"  removing stale {stale.name}")
            stale.unlink()

    stops_source: Path | None = None
    used: dict[str, str] = {}

    for day_type in DAY_TYPES:
        date = dates[day_type]
        used[day_type] = date.isoformat()

        timetable_bin = WORK_DIR / f"timetable.{day_type}.bin"
        stops_bin = WORK_DIR / f"stops.{day_type}.bin"
        stamp = WORK_DIR / f"timetable.{day_type}.stamp"
        want = _stamp_for(gtfs_zip, date)
        fresh = (
            not force
            and timetable_bin.exists()
            and stops_bin.exists()
            and stamp.exists()
            and stamp.read_text().strip() == want
        )

        if fresh:
            log(f"  {day_type} ({date}): reusing parsed timetable")
        else:
            with Timer(f"{day_type} ({date})"):
                log(f"  {day_type} ({date}): parsing GTFS...")
                result = subprocess.run(
                    [
                        node,
                        f"--max-old-space-size={NODE_HEAP_MB}",
                        str(MINOTOR_CLI),
                        "parse-gtfs",
                        "--date",
                        date.isoformat(),
                        "--profileName",
                        GTFS_PROFILE,
                        "--timetableOutputPath",
                        str(timetable_bin),
                        "--stopsOutputPath",
                        str(stops_bin),
                        str(gtfs_zip),
                    ],
                    capture_output=True,
                    text=True,
                )
            if result.returncode != 0:
                log(result.stdout[-2000:])
                log(result.stderr[-2000:])
                die(f"minotor parse-gtfs failed for {date} (exit {result.returncode}).")
            stamp.write_text(want)

        size = _gzip_to(timetable_bin, OUT_DIR / f"timetable.{day_type}.bin.gz")
        log(f"    timetable.{day_type}.bin.gz  {mb(timetable_bin.stat().st_size)} -> {mb(size)}")
        if stops_source is None:
            stops_source = stops_bin

    assert stops_source is not None
    size = _gzip_to(stops_source, OUT_DIR / "stops.bin.gz")
    log(f"    stops.bin.gz  {mb(stops_source.stat().st_size)} -> {mb(size)}")
    return used


def bpuics(gtfs_zip: Path) -> set[int]:
    """Every BPUIC the feed knows, taken from the `<bpuic>[:<platform>]` stop ids.

    Delay rows for stops outside the feed can never be looked up, so they are
    dropped instead of shipped.
    """
    found: set[int] = set()
    with zipfile.ZipFile(gtfs_zip) as z, z.open("stops.txt") as fh:
        for row in csv.DictReader(io.TextIOWrapper(fh, "utf-8-sig")):
            head = row["stop_id"].split(":", 1)[0]
            if head.isdigit():
                found.add(int(head))
    return found
