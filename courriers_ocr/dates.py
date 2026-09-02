"""Extraction heuristique de la date d'un courrier.

On cherche d'abord dans l'en-tête (« Paris, le 12 mars 2024 », « 12/03/2024 »,
« Rechnung vom 03.12.2024 »…), puis, si rien, dans tout le texte.

Tolérant au bruit OCR (o→0, l/i→1) et aux espaces parasites. Ne lève **jamais**
d'exception : renvoie None en cas de doute.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from datetime import date

log = logging.getLogger(__name__)

_HEADER_LINES = 40
_HEADER_CHARS = 3000
_FULLTEXT_CHARS = 20000

_MONTHS = {
    "janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
    "juillet": 7, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11,
    "decembre": 12,
    "janv": 1, "fev": 2, "fevr": 2, "avr": 4, "juil": 7, "juill": 7,
    "sept": 9, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    # allemand
    "januar": 1, "februar": 2, "maerz": 3, "marz": 3, "april": 4, "juni": 6,
    "juli": 7, "august": 8, "oktober": 10, "dezember": 12,
    "jan": 1, "feb": 2, "mrz": 3, "jun": 6, "jul": 7, "aug": 8, "okt": 10, "dez": 12,
    # anglais
    "january": 1, "february": 2, "march": 3, "june": 6, "july": 7,
    "september": 9, "october": 10, "november": 11, "december": 12,
}
_MONTH_ALT = "|".join(sorted((re.escape(m) for m in _MONTHS), key=len, reverse=True))

# fenêtre passée en minuscules + sans accents : on ne corrige que les confusions
# vraiment « chiffres » (pas s/b/g/d/q qui cassaient tout sur du texte).
_DIGIT_FIX = str.maketrans({"o": "0", "l": "1", "i": "1", "|": "1"})
_DIG = r"[0-9oli|]"

_DSEP = r"\s*[/.\-– ]\s*"
_D1 = rf"({_DIG}{{1,2}})"
_D2 = rf"({_DIG}{{2,4}})"

_RE_TEXT = re.compile(
    rf"\b({_DIG}{{1,2}})(?:\s*(?:er|re|e|eme|ere|ste|te|nd|rd|th))?"
    rf"[.,]?\s+({_MONTH_ALT})\.?\s*[.,]?\s+({_DIG}{{2,4}})\b"
)
_RE_TEXT_REV = re.compile(
    rf"\b({_MONTH_ALT})\.?\s+({_DIG}{{1,2}})(?:st|nd|rd|th)?,?\s+({_DIG}{{4}})\b"
)
_RE_ISO = re.compile(rf"\b({_DIG}{{4}}){_DSEP}{_D1}{_DSEP}{_D1}\b")
_RE_NUM = re.compile(rf"\b{_D1}{_DSEP}{_D1}{_DSEP}{_D2}\b")


def _strip_accents(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )


def _int(s: str) -> int | None:
    s = s.translate(_DIGIT_FIX)
    return int(s) if s.isdigit() else None


def _year(v: int) -> int:
    if v > 99:
        return v
    return 2000 + v if v < 80 else 1900 + v


def _valid(y, m, d, today: date) -> date | None:
    if None in (y, m, d) or not (1 <= m <= 12 and 1 <= d <= 31):
        return None
    try:
        dt = date(y, m, d)
    except ValueError:
        return None
    if dt.year < today.year - 25 or dt > date(today.year + 1, today.month, 1):
        return None
    return dt


def _candidates(window: str, today: date):
    norm = _strip_accents(window).lower()

    for m in _RE_TEXT.finditer(norm):
        mon = _MONTHS.get(m.group(2).rstrip("."))
        y, d = _int(m.group(3)), _int(m.group(1))
        dt = _valid(_year(y) if y is not None else None, mon, d, today)
        if dt:
            yield m.start(), 0, dt
    for m in _RE_TEXT_REV.finditer(norm):
        mon = _MONTHS.get(m.group(1).rstrip("."))
        y, d = _int(m.group(3)), _int(m.group(2))
        dt = _valid(_year(y) if y is not None else None, mon, d, today)
        if dt:
            yield m.start(), 0, dt
    for m in _RE_ISO.finditer(norm):
        dt = _valid(_int(m.group(1)), _int(m.group(2)), _int(m.group(3)), today)
        if dt:
            yield m.start(), 1, dt
    for m in _RE_NUM.finditer(norm):
        a, b, y = _int(m.group(1)), _int(m.group(2)), _int(m.group(3))
        if None in (a, b, y):
            continue
        day, month = (b, a) if a > 12 and b <= 12 else (a, b)   # défaut JJ/MM
        dt = _valid(_year(y), month, day, today)
        if dt:
            yield m.start(), 2, dt


def _pick(window: str, today: date) -> str | None:
    found = list(_candidates(window, today))
    if not found:
        return None
    found.sort(key=lambda t: (t[0], t[1]))
    return found[0][2].isoformat()


def extract_document_date(text: str, today: date | None = None) -> str | None:
    """Date du courrier au format 'YYYY-MM-DD', ou None. Ne lève jamais."""
    if not text:
        return None
    today = today or date.today()
    try:
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        header = "\n".join(lines[:_HEADER_LINES])[:_HEADER_CHARS]
        return _pick(header, today) or _pick(text[:_FULLTEXT_CHARS], today)
    except Exception:  # noqa: BLE001 — jamais fatal pour l'ingestion
        log.exception("extraction de date en échec (ignorée)")
        return None
