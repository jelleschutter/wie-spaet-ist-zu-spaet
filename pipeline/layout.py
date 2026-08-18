"""Shared constants, paths and small helpers for the data pipeline."""

from __future__ import annotations

import datetime as dt
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

RAW_DIR = REPO / "data" / "raw"
WORK_DIR = REPO / "data" / "work"
OUT_DIR = REPO / "static" / "data"

GTFS_ZIP = RAW_DIR / "gtfs_complete.zip"
ISTDATEN_DIR = RAW_DIR / "istdaten"

# Day types are calendar weekdays, in `datetime.date.weekday()` order. The names
# (not the indices) are what the browser sees, so the JS side never has to know
# about Python's Monday-first vs. JavaScript's Sunday-first weekday numbering.
DAY_TYPES = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)

# Delay rows are sharded by `bpuic % BUCKETS` per day type: enough buckets that
# one lookup fetches ~20 KB, few enough to stay a manageable file count.
BUCKETS = 1024

# A weekday's aggregation is run in this many passes over `bpuic % AGG_CHUNKS`,
# which bounds peak memory no matter how many months are in the samples (a year
# of one weekday is ~115 M rows, and the exact percentile has to hold every
# observation of a group at once). Must divide BUCKETS, so that each output
# shard is produced entirely within one pass.
AGG_CHUNKS = 8
assert BUCKETS % AGG_CHUNKS == 0

# A delay row: lineIdx u16 | plannedDepMin u16 | catchBuffer i16 | avg i16 |
# samples u8 | dayOffset i8. Keep in sync with src/lib/transit/delays.ts.
ROW_SIZE = 10
FORMAT_VERSION = 2

I16_MIN, I16_MAX = -32768, 32767


def log(message: str = "") -> None:
    print(message, flush=True)


def step(title: str) -> None:
    log(f"\n=== {title}")


def mb(byte_count: float) -> str:
    return f"{byte_count / 1e6:.1f} MB"


def num(value: int) -> str:
    return f"{value:,}"


def duration(seconds: float) -> str:
    if seconds < 90:
        return f"{seconds:.0f}s"
    return f"{seconds / 60:.1f}min"


class Timer:
    """Measures a step and reports how long it took."""

    def __init__(self, label: str) -> None:
        self.label = label

    def __enter__(self) -> "Timer":
        self.started = time.monotonic()
        return self

    def __exit__(self, *exc: object) -> None:
        if exc[0] is None:
            log(f"  {self.label} took {duration(time.monotonic() - self.started)}")


def last_complete_months(today: dt.date, count: int) -> list[tuple[int, int]]:
    """The `count` whole months before `today`, oldest first.

    The current month is skipped: each monthly Ist-Daten archive is published
    only after the month has ended.
    """
    year, month = today.year, today.month
    out: list[tuple[int, int]] = []
    for _ in range(count):
        month -= 1
        if month == 0:
            month, year = 12, year - 1
        out.append((year, month))
    return list(reversed(out))


def die(message: str) -> None:
    log(f"\nerror: {message}")
    sys.exit(1)
