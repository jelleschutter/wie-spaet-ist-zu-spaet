"""Swiss nationwide public holidays, which run the Sunday timetable.

Only the holidays that apply in every canton are listed - cantonal ones
(Fasnachtsmontag, Bettag, ...) vary too much to bucket nationally, and the
Ist-Daten give no hint which schedule actually ran.

Keep in sync with src/lib/transit/holidays.ts.
"""

from __future__ import annotations

import datetime as dt
from functools import lru_cache


def easter_sunday(year: int) -> dt.date:
    """Gregorian Easter Sunday (anonymous Gregorian algorithm)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741 - the algorithm's own name
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return dt.date(year, month, day + 1)


@lru_cache(maxsize=32)
def holidays(year: int) -> dict[dt.date, str]:
    """The nationwide holidays of a year, mapped to their German names."""
    easter = easter_sunday(year)
    return {
        dt.date(year, 1, 1): "Neujahr",
        dt.date(year, 1, 2): "Berchtoldstag",
        easter - dt.timedelta(days=2): "Karfreitag",
        easter + dt.timedelta(days=1): "Ostermontag",
        easter + dt.timedelta(days=39): "Auffahrt",
        easter + dt.timedelta(days=50): "Pfingstmontag",
        dt.date(year, 8, 1): "Bundesfeier",
        dt.date(year, 12, 25): "Weihnachten",
        dt.date(year, 12, 26): "Stephanstag",
    }


def holiday_name(date: dt.date) -> str | None:
    return holidays(date.year).get(date)


def is_holiday(date: dt.date) -> bool:
    return date in holidays(date.year)
