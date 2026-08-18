"""Downloads the upstream feeds: the GTFS timetable and the monthly Ist-Daten.

Both sources are large (GTFS ~165 MB, each Ist-Daten month ~1.2 GB), so
downloads are resumable and skipped when the local copy already matches the
remote size.
"""

from __future__ import annotations

import datetime as dt
import time
from pathlib import Path

import httpx

from layout import ISTDATEN_DIR, GTFS_ZIP, log, mb

GTFS_URL = "https://gtfs.geops.ch/dl/gtfs_complete.zip"
ISTDATEN_URL = "https://archive.opentransportdata.swiss/istdaten/{year}/ist-daten-v2-{year}-{month:02d}.zip"

CHUNK = 1 << 20
TIMEOUT = httpx.Timeout(30.0, read=120.0)


def _remote_info(client: httpx.Client, url: str) -> tuple[int | None, str | None]:
    """(content length, last-modified) of a URL, as far as the server tells us."""
    res = client.head(url, follow_redirects=True)
    res.raise_for_status()
    length = res.headers.get("content-length")
    return (int(length) if length else None), res.headers.get("last-modified")


def _fetch(client: httpx.Client, url: str, dest: Path, label: str) -> bool:
    """Downloads `url` to `dest`, resuming a partial file. True if bytes moved."""
    size, last_modified = _remote_info(client, url)
    stamp = dest.with_suffix(dest.suffix + ".fetched")

    if dest.exists() and size is not None and dest.stat().st_size == size:
        if last_modified is None or (stamp.exists() and stamp.read_text().strip() == last_modified):
            log(f"  {label}: up to date ({mb(dest.stat().st_size)})")
            return False

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if part.exists() else 0
    # Only resume when we know the target size and haven't overshot it.
    if size is not None and have >= size:
        have = 0
    headers = {"Range": f"bytes={have}-"} if have else {}

    started = time.monotonic()
    with client.stream("GET", url, headers=headers, follow_redirects=True) as res:
        if have and res.status_code != 206:
            have = 0  # server ignored the range - start over
        res.raise_for_status()
        total = size if size is not None else have + int(res.headers.get("content-length", 0))
        with part.open("ab" if have else "wb") as fh:
            done = have
            next_report = time.monotonic() + 5
            for chunk in res.iter_bytes(CHUNK):
                fh.write(chunk)
                done += len(chunk)
                if time.monotonic() >= next_report:
                    pct = f"{100 * done / total:.0f}%" if total else "?"
                    rate = done / max(1e-6, time.monotonic() - started) / 1e6
                    log(f"  {label}: {pct} ({mb(done)}, {rate:.1f} MB/s)")
                    next_report = time.monotonic() + 5

    part.replace(dest)
    if last_modified:
        stamp.write_text(last_modified)
    log(
        f"  {label}: {mb(dest.stat().st_size)} in "
        f"{time.monotonic() - started:.0f}s"
    )
    return True


def gtfs(client: httpx.Client | None = None) -> Path:
    """Downloads the current geops GTFS feed (rebuilt daily)."""
    with client or httpx.Client(timeout=TIMEOUT) as owned:
        _fetch(owned, GTFS_URL, GTFS_ZIP, "gtfs_complete.zip")
    return GTFS_ZIP


def istdaten(months: list[tuple[int, int]]) -> list[Path]:
    """Downloads one monthly Ist-Daten archive per (year, month)."""
    paths: list[Path] = []
    with httpx.Client(timeout=TIMEOUT) as client:
        for year, month in months:
            url = ISTDATEN_URL.format(year=year, month=month)
            dest = ISTDATEN_DIR / f"ist-daten-v2-{year}-{month:02d}.zip"
            try:
                _fetch(client, url, dest, dest.name)
            except httpx.HTTPStatusError as err:
                if err.response.status_code == 404:
                    log(f"  {dest.name}: not published yet (HTTP 404) - skipping")
                    continue
                raise
            paths.append(dest)
    return paths


def everything(months: list[tuple[int, int]]) -> tuple[Path, list[Path]]:
    """Fetches the GTFS feed and the requested Ist-Daten months."""
    with httpx.Client(timeout=TIMEOUT) as client:
        _fetch(client, GTFS_URL, GTFS_ZIP, "gtfs_complete.zip")
    return GTFS_ZIP, istdaten(months)


def month_label(year: int, month: int) -> str:
    return f"{year}-{month:02d}"


def month_dates(year: int, month: int) -> tuple[dt.date, dt.date]:
    """First and last day of a month."""
    first = dt.date(year, month, 1)
    last = dt.date(year + (month == 12), month % 12 + 1, 1) - dt.timedelta(days=1)
    return first, last
