"""Turns the monthly Ist-Daten archives into per-station delay statistics.

Scale is the whole problem here: twelve months are ~15 GB of zipped CSV that
expand to roughly 210 GB (one ~580 MB file per calendar day, ~2.3 M stop events
each). So the work is split in two:

  1. Per day, DuckDB reads the CSV, keeps only real departures and reduces each
     row to (BPUIC, line, planned minute, day offset, delay) in a small zstd
     parquet file. This is the pass that touches the bulk of the data.
  2. Per weekday, DuckDB aggregates that weekday's ~52 parquet files into one
     row per scheduled service: sample count, average delay and the 10th
     percentile - the "how late can I still be" buffer the app shows.

Both stages are resumable: a day whose parquet file already exists is skipped.

Delays are joined to the timetable by BPUIC, which the geops GTFS carries as
the `<bpuic>[:<platform>]` stop id prefix and the Ist-Daten always report. That
keeps the browser out of SLOID/DIDOK territory entirely - it just needs the
number in front of the colon.

One wrinkle in that join: the Ist-Daten BPUIC column mixes 7-digit station
numbers (~500 k rows/day) with 9-digit platform codes that append a two-digit
platform to them (~2.1 M rows/day). Truncating to the leading seven digits
raises the number of stations that match the feed from ~4 k to ~24 k, of which
99.3% are found in the GTFS - so the reading is safe, and station-level is the
granularity the lookup wants anyway.
"""

from __future__ import annotations

import datetime as dt
import gzip
import re
import shutil
import struct
import zipfile
from collections.abc import Callable
from pathlib import Path

import duckdb
import numpy as np

from holidays import holiday_name
from layout import (
    AGG_CHUNKS,
    BUCKETS,
    DAY_TYPES,
    FORMAT_VERSION,
    I16_MAX,
    I16_MIN,
    ROW_SIZE,
    Timer,
    log,
    mb,
    num,
)

MEMBER_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})[_-].*IstDaten.*\.csv$", re.IGNORECASE)

# A day's rows, reduced to what a departure board needs. Written per calendar
# day so an interrupted run resumes, and so stage 2 only reads what it needs.
EXTRACT_SQL = """
COPY (
    SELECT
        bpuic,
        line,
        CAST(date_part('hour', planned) * 60 + date_part('minute', planned) AS SMALLINT) AS dep_min,
        CAST(date_diff('day', CAST(service_day AS DATE), CAST(planned AS DATE)) AS TINYINT) AS day_offset,
        CAST(date_diff('second', planned, actual) AS INTEGER) AS delay
    FROM (
        SELECT
            -- Most rows report a 9-digit platform code (7-digit station + 2-digit
            -- platform); the timetable side is station-level, so keep the head.
            TRY_CAST(CASE WHEN length(BPUIC) > 7 THEN BPUIC[1:7] ELSE BPUIC END AS INTEGER) AS bpuic,
            trim(LINIEN_TEXT) AS line,
            TRY_STRPTIME(ABFAHRTSZEIT, ['%d.%m.%Y %H:%M:%S', '%d.%m.%Y %H:%M']) AS planned,
            TRY_STRPTIME(AB_PROGNOSE, ['%d.%m.%Y %H:%M:%S', '%d.%m.%Y %H:%M']) AS actual,
            TRY_STRPTIME(BETRIEBSTAG, ['%d.%m.%Y']) AS service_day,
            upper(trim(AB_PROGNOSE_STATUS)) AS status,
            lower(trim(FAELLT_AUS_TF)) AS cancelled,
            lower(trim(DURCHFAHRT_TF)) AS passing,
            lower(trim(ZUSATZFAHRT_TF)) AS extra
        -- all_varchar keeps DuckDB from sniffing types out of 2.3 M rows of
        -- mixed date formats; every cast below is explicit and forgiving.
        FROM read_csv('{csv}', delim = ';', header = true, all_varchar = true)
    )
    WHERE bpuic IS NOT NULL
      AND line <> ''
      AND planned IS NOT NULL
      AND actual IS NOT NULL
      AND service_day IS NOT NULL
      -- Cancelled trips never left, pass-throughs don't let anyone board, and
      -- extra trips aren't in the timetable this data is matched against.
      AND cancelled <> 'true'
      AND passing <> 'true'
      AND extra <> 'true'
      AND status NOT IN ('UNBEKANNT', '')
      AND date_diff('day', CAST(service_day AS DATE), CAST(planned AS DATE)) BETWEEN -1 AND 1
      -- A handful of rows carry a nonsense AB_PROGNOSE (year 1900 and the like),
      -- which is both meaningless and enough to overflow the cast above. Bound
      -- the delay on the raw expression so those rows never reach it.
      AND date_diff('second', planned, actual) BETWEEN -86400 AND 86400
) TO '{out}' (FORMAT parquet, COMPRESSION zstd)
"""

AGGREGATE_SQL = """
WITH per_service AS (
    SELECT
        bpuic,
        line,
        dep_min,
        day_offset,
        CAST(count(*) AS INTEGER) AS samples,
        CAST(round(avg(delay)) AS INTEGER) AS avg_delay,
        -- The catch buffer: the largest offset B such that the vehicle's delay was
        -- >= B on at least 90% of observed days, so arriving B seconds after the
        -- planned departure still catches it that often. That is the k-th smallest
        -- delay with k = floor(n / 10), by nearest rank on the observed values.
        --
        -- Deliberately NOT quantile_cont: interpolating between two observations
        -- invents a buffer the data doesn't support once n < 10 (with delays
        -- [-30, 150] it would claim -12 s, which holds on 1 of 2 days, not 90%).
        list_sort(list(delay))[CAST(floor(count(*) / 10.0) AS BIGINT) + 1] AS p10
    FROM read_parquet('{glob}')
    WHERE bpuic % {chunks} = {chunk}
    GROUP BY ALL
),
best AS (
    -- The browser matches on line + planned minute only, so where a service
    -- appears under more than one day offset keep the best-sampled row.
    SELECT
        bpuic,
        line,
        dep_min,
        max(samples) AS samples,
        arg_max(avg_delay, samples) AS avg_delay,
        arg_max(p10, samples) AS p10,
        arg_max(day_offset, samples) AS day_offset
    FROM per_service
    GROUP BY 1, 2, 3
)
SELECT
    best.bpuic,
    lines.idx AS line_idx,
    best.dep_min,
    best.p10,
    best.avg_delay,
    best.samples,
    best.day_offset
FROM best
JOIN lines ON lines.line = best.line
JOIN allowed ON allowed.bpuic = best.bpuic
WHERE best.samples >= {min_samples}
ORDER BY best.bpuic, lines.idx, best.dep_min
"""

# One delay row on the wire; matches ROW_SIZE and src/lib/transit/delays.ts.
ROW_DTYPE = np.dtype(
    [
        ("line", "<u2"),
        ("dep", "<u2"),
        ("p10", "<i2"),
        ("avg", "<i2"),
        ("samples", "u1"),
        ("offset", "i1"),
    ]
)
assert ROW_DTYPE.itemsize == ROW_SIZE


def day_type_of(date: dt.date) -> str:
    """The bucket a service day belongs to: its weekday, or Sunday on a holiday.

    Public transport runs the Sunday timetable on nationwide holidays, so a
    1 August that falls on a Tuesday would otherwise poison Tuesday's statistics
    with a completely different service pattern.
    """
    return "sunday" if holiday_name(date) else DAY_TYPES[date.weekday()]


def connect(work_dir: Path, memory_limit: str) -> duckdb.DuckDBPyConnection:
    """An in-process DuckDB that spills to the work directory, not to C:\\."""
    con = duckdb.connect()
    spill = work_dir / "duckdb"
    spill.mkdir(parents=True, exist_ok=True)
    con.execute(f"SET temp_directory = '{_q(spill)}'")
    con.execute(f"SET memory_limit = '{memory_limit}'")
    con.execute("SET preserve_insertion_order = false")
    return con


def _q(path: Path | str) -> str:
    return str(path).replace("'", "''")


def _members(archive: Path) -> list[tuple[dt.date, str]]:
    """The (service day, member name) pairs in a monthly archive, in date order."""
    out: list[tuple[dt.date, str]] = []
    with zipfile.ZipFile(archive) as z:
        for name in z.namelist():
            match = MEMBER_RE.search(name)
            if match:
                year, month, day = (int(g) for g in match.groups())
                out.append((dt.date(year, month, day), name))
    return sorted(out)


def extract(
    con: duckdb.DuckDBPyConnection,
    archives: list[Path],
    work_dir: Path,
    *,
    day_limit: int | None = None,
    force: bool = False,
    fetch: Callable[[Path], bool] | None = None,
    prune: bool = False,
) -> tuple[dict[str, list[str]], set[str]]:
    """Reduces each day in each archive to a parquet file of delay samples.

    `fetch` is called with an archive that isn't on disk yet and returns whether
    it could be downloaded; `prune` deletes each archive once its days are read.
    Together they keep peak disk at one month rather than all twelve.

    Returns the service days covered per weekday and every line text seen.
    """
    samples_dir = work_dir / "samples"
    tmp_csv = work_dir / "tmp" / "istdaten.csv"
    tmp_csv.parent.mkdir(parents=True, exist_ok=True)

    days: dict[str, list[str]] = {day: [] for day in DAY_TYPES}
    lines: set[str] = set()

    try:
        _extract_all(
            con, archives, samples_dir, tmp_csv, days, lines, day_limit, force, fetch, prune
        )
    finally:
        # The scratch CSV is ~580 MB; don't leave it behind on an early exit.
        tmp_csv.unlink(missing_ok=True)
    return days, lines


def _extract_all(
    con: duckdb.DuckDBPyConnection,
    archives: list[Path],
    samples_dir: Path,
    tmp_csv: Path,
    days: dict[str, list[str]],
    lines: set[str],
    day_limit: int | None,
    force: bool,
    fetch: Callable[[Path], bool] | None,
    prune: bool,
) -> None:
    processed = 0
    for archive in archives:
        if fetch is not None and not archive.exists() and not fetch(archive):
            continue  # not published yet - download.istdaten() has said so
        if not archive.exists():
            log(f"  {archive.name}: missing - skipping")
            continue
        members = _members(archive)
        if not members:
            log(f"  {archive.name}: no IstDaten members found - skipping")
            continue
        log(f"  {archive.name}: {len(members)} service days")
        for date, member in members:
            if day_limit is not None and processed >= day_limit:
                log(f"  stopping after {processed} days (--days)")
                return
            day_type = day_type_of(date)
            parquet = samples_dir / day_type / f"{date.isoformat()}.parquet"
            parquet.parent.mkdir(parents=True, exist_ok=True)
            # A holiday moves between weekday folders when the calendar changes,
            # so drop any copy of this day filed under a different day type.
            for stale in samples_dir.glob(f"*/{date.isoformat()}.parquet"):
                if stale != parquet:
                    stale.unlink()

            if parquet.exists() and not force:
                days[day_type].append(date.isoformat())
                lines |= _lines_in(con, parquet)
                processed += 1
                continue

            with zipfile.ZipFile(archive) as z, z.open(member) as src, tmp_csv.open("wb") as dst:
                shutil.copyfileobj(src, dst, length=1 << 23)

            con.execute(EXTRACT_SQL.format(csv=_q(tmp_csv), out=_q(parquet)))
            kept = con.execute(f"SELECT count(*) FROM read_parquet('{_q(parquet)}')").fetchone()[0]
            lines |= _lines_in(con, parquet)
            days[day_type].append(date.isoformat())
            processed += 1
            feiertag = holiday_name(date)
            log(
                f"    {date} {day_type:9s} {num(kept):>10s} departures "
                f"-> {mb(parquet.stat().st_size)}"
                + (f"   ({feiertag}, counted as Sunday)" if feiertag else "")
            )

        if prune:
            # The `.fetched` stamp goes with it, or the next download would
            # believe the (now absent) archive is still up to date.
            size = archive.stat().st_size
            archive.unlink()
            archive.with_suffix(archive.suffix + ".fetched").unlink(missing_ok=True)
            log(f"  {archive.name}: removed, {mb(size)} freed (--prune)")
    return days, lines


def _lines_in(con: duckdb.DuckDBPyConnection, parquet: Path) -> set[str]:
    rows = con.execute(f"SELECT DISTINCT line FROM read_parquet('{_q(parquet)}')").fetchall()
    return {row[0] for row in rows}


def _register(
    con: duckdb.DuckDBPyConnection, line_table: list[str], allowed: set[int]
) -> None:
    con.execute("CREATE OR REPLACE TABLE lines (line VARCHAR, idx INTEGER)")
    con.executemany(
        "INSERT INTO lines VALUES (?, ?)", [(line, i) for i, line in enumerate(line_table)]
    )
    con.execute("CREATE OR REPLACE TABLE allowed (bpuic INTEGER)")
    con.executemany("INSERT INTO allowed VALUES (?)", [(b,) for b in sorted(allowed)])


def shard(
    con: duckdb.DuckDBPyConnection,
    work_dir: Path,
    out_dir: Path,
    *,
    line_table: list[str],
    allowed: set[int],
    day_types: list[str],
    min_samples: int,
) -> dict[str, object]:
    """Aggregates the samples per weekday and writes the gzipped delay shards."""
    _register(con, line_table, allowed)

    delays_dir = out_dir / "delays"
    if delays_dir.exists():
        shutil.rmtree(delays_dir)

    stations: set[int] = set()
    total_rows = 0
    total_bytes = 0
    total_files = 0
    clamped = 0
    covered: list[str] = []

    for day_type in day_types:
        glob = work_dir / "samples" / day_type / "*.parquet"
        if not list((work_dir / "samples" / day_type).glob("*.parquet")):
            log(f"  {day_type}: no samples - skipped")
            continue

        written = files = size = 0
        with Timer(f"{day_type} aggregation"):
            # One pass per bpuic chunk keeps peak memory flat; the chunks are
            # disjoint sets of whole shards, so each file is written exactly once.
            for chunk in range(AGG_CHUNKS):
                cols = con.execute(
                    AGGREGATE_SQL.format(
                        glob=_q(glob), min_samples=min_samples, chunks=AGG_CHUNKS, chunk=chunk
                    )
                ).fetchnumpy()
                part = _write_day(cols, delays_dir / day_type)
                stations.update(np.unique(cols["bpuic"]).tolist())
                written += part[0]
                files += part[1]
                size += part[2]
                clamped += part[3]

        total_rows += written
        total_files += files
        total_bytes += size
        covered.append(day_type)
        log(f"  {day_type}: {num(written)} services, {num(files)} shards, {mb(size)}")

    if clamped:
        log(f"  note: {num(clamped)} outlier delay values clamped to +/-{I16_MAX} s")

    return {
        "dayTypes": covered,
        "rows": total_rows,
        "files": total_files,
        "bytes": total_bytes,
        "stations": len(stations),
    }


def _write_day(cols: dict[str, np.ndarray], dest: Path) -> tuple[int, int, int, int]:
    """Writes one weekday's shards. Rows arrive sorted by (bpuic, line, minute)."""
    bpuic = np.asarray(cols["bpuic"], dtype=np.int64)
    count = bpuic.size
    if count == 0:
        return 0, 0, 0, 0

    p10 = np.asarray(cols["p10"], dtype=np.int64)
    avg = np.asarray(cols["avg_delay"], dtype=np.int64)
    clamped = int(np.count_nonzero((p10 < I16_MIN) | (p10 > I16_MAX))) + int(
        np.count_nonzero((avg < I16_MIN) | (avg > I16_MAX))
    )

    rows = np.empty(count, dtype=ROW_DTYPE)
    rows["line"] = np.asarray(cols["line_idx"], dtype=np.uint16)
    rows["dep"] = np.asarray(cols["dep_min"], dtype=np.uint16)
    rows["p10"] = np.clip(p10, I16_MIN, I16_MAX).astype(np.int16)
    rows["avg"] = np.clip(avg, I16_MIN, I16_MAX).astype(np.int16)
    rows["samples"] = np.clip(np.asarray(cols["samples"], dtype=np.int64), 0, 255).astype(np.uint8)
    rows["offset"] = np.asarray(cols["day_offset"], dtype=np.int8)
    payload = rows.view(np.uint8).reshape(count, ROW_SIZE)

    # Station blocks are contiguous because the query sorted by bpuic.
    starts = np.concatenate(([0], np.flatnonzero(np.diff(bpuic)) + 1))
    ends = np.concatenate((starts[1:], [count]))
    ids = bpuic[starts]

    bucket_of = ids % BUCKETS
    order = np.argsort(bucket_of, kind="stable")  # stable => bpuic stays ascending
    grouped = bucket_of[order]
    bounds = np.concatenate(
        ([0], np.flatnonzero(np.diff(grouped)) + 1, [order.size])
    )

    dest.mkdir(parents=True, exist_ok=True)
    total_bytes = 0
    for i in range(bounds.size - 1):
        members = order[bounds[i] : bounds[i + 1]]
        bucket = int(grouped[bounds[i]])

        header = bytearray(struct.pack("<BI", FORMAT_VERSION, members.size))
        body: list[np.ndarray] = []
        row_start = 0
        for member in members:
            begin, end = int(starts[member]), int(ends[member])
            header += struct.pack("<III", int(ids[member]), row_start, end - begin)
            body.append(payload[begin:end])
            row_start += end - begin

        blob = gzip.compress(bytes(header) + np.concatenate(body).tobytes(), 9, mtime=0)
        (dest / f"{bucket}.bin.gz").write_bytes(blob)
        total_bytes += len(blob)

    return count, int(bounds.size - 1), total_bytes, clamped
