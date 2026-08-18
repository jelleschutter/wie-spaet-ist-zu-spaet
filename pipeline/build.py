#!/usr/bin/env python
"""Builds everything the deployed site serves out of static/data/.

    uv run --project pipeline python pipeline/build.py

Three steps, each skippable and each resumable:

  1. download    the geops GTFS feed and the last 12 monthly Ist-Daten archives
  2. timetables  one minotor timetable per weekday, plus the stops index
  3. delays      per-station delay statistics, sharded per weekday

Nothing else runs before deployment: `npm run build` only bundles the frontend
around the files this produces.

Useful flags:

    --days 3          only process three Ist-Daten days (fast smoke test)
    --months 1        only fetch/aggregate the most recent month
    --only delays     re-run a single step
    --today 2026-08-17  anchor the timetable dates and month list to a fixed day
    --prune           fetch each Ist-Daten month just in time and delete it after
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import time
from pathlib import Path

import delays as delays_step
import download as download_step
import timetables as timetables_step
from layout import (
    BUCKETS,
    DAY_TYPES,
    FORMAT_VERSION,
    GTFS_ZIP,
    ISTDATEN_DIR,
    OUT_DIR,
    WORK_DIR,
    die,
    duration,
    last_complete_months,
    log,
    mb,
    num,
    step,
)

STEPS = ("download", "timetables", "delays")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the static data bundle in static/data/.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--months", type=int, default=12, help="how many whole months of Ist-Daten (default: 12)"
    )
    parser.add_argument(
        "--days", type=int, help="stop after N Ist-Daten service days (for smoke tests)"
    )
    parser.add_argument(
        "--min-samples",
        type=int,
        default=1,
        help="drop services observed fewer than N times (default: 1, keep everything)",
    )
    parser.add_argument("--only", choices=STEPS, help="run just one step")
    parser.add_argument("--skip", nargs="+", choices=STEPS, default=[], help="skip steps")
    parser.add_argument(
        "--force", action="store_true", help="re-parse/re-extract even when outputs look current"
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="download each Ist-Daten archive right before it is read and delete it "
        "again afterwards: bounds peak disk to one month instead of ~15 GB, at the "
        "cost of re-downloading on the next run (for CI)",
    )
    parser.add_argument("--memory-limit", default="8GB", help="DuckDB memory limit (default: 8GB)")
    parser.add_argument("--node", default="node", help="node executable (default: node)")
    parser.add_argument(
        "--today", help="pretend today is this date (YYYY-MM-DD), for reproducible runs"
    )
    return parser.parse_args()


def wanted(args: argparse.Namespace, name: str) -> bool:
    if args.only:
        return args.only == name
    return name not in args.skip


def load_meta() -> dict:
    """The meta.json on disk, so a partial re-run doesn't drop other steps' facts."""
    path = OUT_DIR / "meta.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def main() -> None:
    args = parse_args()
    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()
    started = time.monotonic()
    # Only what this run actually rebuilds; merged over the meta.json on disk at
    # the end, so running two steps separately (or in parallel) keeps both.
    meta: dict = {}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    months = last_complete_months(today, args.months)
    log(f"wie-spaet-ist-zu-spaet data build   (today {today})")
    log(f"  Ist-Daten months: {months[0][0]}-{months[0][1]:02d} .. {months[-1][0]}-{months[-1][1]:02d}")

    # ---------------------------------------------------------------- download
    if wanted(args, "download"):
        step("Downloading upstream feeds")
        download_step.gtfs()
        # The Ist-Daten are 15 GB and only the delays step reads them - with
        # --prune it fetches them one archive at a time instead.
        if wanted(args, "delays") and not args.prune:
            download_step.istdaten(months)
    if not GTFS_ZIP.exists():
        die(f"{GTFS_ZIP} is missing - run the download step first.")

    # -------------------------------------------------------------- timetables
    if wanted(args, "timetables"):
        step("Building timetables (minotor)")
        window = timetables_step.feed_window(GTFS_ZIP)
        dates = timetables_step.timetable_dates(today, window)
        log("  dates (nearest occurrence of each weekday):")
        for day_type, date in dates.items():
            offset = (date - today).days
            when = "today" if offset == 0 else f"{offset:+d}d"
            log(f"    {day_type:9s} {date} ({when})")
        meta["timetableDates"] = timetables_step.build(
            GTFS_ZIP, dates, force=args.force, node=args.node
        )

    # ------------------------------------------------------------------ delays
    if wanted(args, "delays"):
        step("Reading Ist-Daten")
        fetch = None
        if args.prune:
            # Nothing is on disk yet, so name what the months ask for and let
            # the extract loop pull each one down as it gets there.
            wanted_months = {
                ISTDATEN_DIR / f"ist-daten-v2-{y}-{m:02d}.zip": (y, m) for y, m in months
            }
            archives = list(wanted_months)

            def fetch(archive: Path) -> bool:
                return bool(download_step.istdaten([wanted_months[archive]]))
        else:
            archives = sorted(ISTDATEN_DIR.glob("ist-daten-v2-*.zip"))
            keep = {f"ist-daten-v2-{y}-{m:02d}.zip" for y, m in months}
            archives = [a for a in archives if a.name in keep]
            if not archives:
                die(f"no Ist-Daten archives for the requested months in {ISTDATEN_DIR}.")

        con = delays_step.connect(WORK_DIR, args.memory_limit)
        days, lines = delays_step.extract(
            con,
            archives,
            WORK_DIR,
            day_limit=args.days,
            force=args.force,
            fetch=fetch,
            prune=args.prune,
        )
        covered = sum(len(v) for v in days.values())
        if covered == 0:
            die("no Ist-Daten service days were processed.")
        log(f"  {num(covered)} service days, {num(len(lines))} distinct lines")

        step("Aggregating delays and writing shards")
        line_table = sorted(lines)
        allowed = timetables_step.bpuics(GTFS_ZIP)
        log(f"  {num(len(allowed))} BPUICs in the GTFS feed")
        summary = delays_step.shard(
            con,
            WORK_DIR,
            OUT_DIR,
            line_table=line_table,
            allowed=allowed,
            day_types=[d for d in DAY_TYPES if days[d]],
            min_samples=args.min_samples,
        )
        con.close()

        meta["lines"] = line_table
        meta["delays"] = {
            "dayTypes": summary["dayTypes"],
            "days": {d: len(days[d]) for d in DAY_TYPES if days[d]},
            "buckets": BUCKETS,
            "stations": summary["stations"],
            "minSamples": args.min_samples,
        }
        meta["istdatenMonths"] = [f"{y}-{m:02d}" for y, m in months]

    # -------------------------------------------------------------------- meta
    step("Writing meta.json")
    service_days = [d for d in DAY_TYPES if (OUT_DIR / f"timetable.{d}.bin.gz").exists()]
    if not service_days and wanted(args, "timetables"):
        die("no timetable.<weekday>.bin.gz files in static/data - run the timetables step.")
    meta["version"] = FORMAT_VERSION
    meta["generatedAt"] = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    if service_days:
        meta["serviceDays"] = service_days
    else:
        log("  no timetables here - serviceDays left to the run that builds them")
    # Re-read at the last moment: another step may have written since we started.
    merged = {**load_meta(), **meta}
    merged.setdefault("lines", [])
    (OUT_DIR / "meta.json").write_text(
        json.dumps(merged, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    meta = merged

    total = sum(p.stat().st_size for p in OUT_DIR.rglob("*") if p.is_file())
    files = sum(1 for p in OUT_DIR.rglob("*") if p.is_file())
    log(f"  service days: {', '.join(service_days) or '-'}")
    log(f"  delay day types: {', '.join(meta.get('delays', {}).get('dayTypes', [])) or '-'}")
    log(f"\nDone in {duration(time.monotonic() - started)}: {mb(total)} in {num(files)} files under static/data/")


if __name__ == "__main__":
    main()
