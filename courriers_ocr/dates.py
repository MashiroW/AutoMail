"""Extraction heuristique de la date d'un courrier.

On regarde uniquement l'en-tête (les premières lignes), là où la date est
quasiment toujours placée : « Paris, le 12 mars 2024 », « 12/03/2024 », etc.
Aucune dépendance externe : le parsing est fait à la main pour rester
déterministe et testable.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date

# nombre de lignes non vides d'en-tête inspectées
_HEADER_LINES = 15
_HEADER_CHARS = 1400

_MONTHS = {
    # français
    "janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
    "juillet": 7, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11,
    "decembre": 12,
    # abréviations FR courantes
    "janv": 1, "fevr": 2, "avr": 4, "juil": 7, "sept": 9, "oct": 10,
    "nov": 11, "dec": 12,
    # allemand
    "januar": 1, "februar": 2, "maerz": 3, "april": 4, "juni": 6, "juli": 7,
    "august": 8, "oktober": 10, "dezember": 12,
    # anglais (au cas où)
    "january": 1, "february": 2, "march": 3, "june": 6, "july": 7,
    "september": 9, "october": 10, "november": 11, "december": 12,
}

_MONTH_ALT = "|".join(sorted(_MONTHS, key=len, reverse=True))

_RE_TEXT = re.compile(
    r"\b(\d{1,2})(?:er|e|\.)?\s+(" + _MONTH_ALT + r")\.?\s+(\d{4})\b",
    re.IGNORECASE,
)
_RE_NUM = re.compile(r"\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b")
_RE_ISO = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")


def _strip_accents(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )


def _valid(y: int, m: int, d: int, today: date) -> date | None:
    if not (1 <= m <= 12 and 1 <= d <= 31):
        return None
    try:
        dt = date(y, m, d)
    except ValueError:
        return None
    # un courrier n'est pas daté dans le futur (petite tolérance) ni trop vieux
    if dt.year < today.year - 20 or dt > today.replace(year=today.year + 1):
        return None
    return dt


def _from_num(a: int, b: int, c: int, today: date) -> date | None:
    # année sur 2 chiffres -> 20xx (sinon 19xx)
    year = c if c > 99 else (2000 + c if c < 80 else 1900 + c)
    # ordre européen JJ/MM/AAAA ; on inverse si le 1er groupe est clairement un mois
    day, month = a, b
    if a > 12 and b <= 12:
        day, month = b, a
    return _valid(year, month, day, today)


def _candidates(header: str, today: date):
    """Génère (position, priorité, date) — priorité 0 = plus fiable."""
    norm = _strip_accents(header)

    for m in _RE_TEXT.finditer(norm):
        d, mon, y = int(m.group(1)), _MONTHS[m.group(2).lower()], int(m.group(3))
        dt = _valid(y, mon, d, today)
        if dt:
            yield m.start(), 0, dt

    for m in _RE_ISO.finditer(norm):
        dt = _valid(int(m.group(1)), int(m.group(2)), int(m.group(3)), today)
        if dt:
            yield m.start(), 1, dt

    for m in _RE_NUM.finditer(norm):
        dt = _from_num(int(m.group(1)), int(m.group(2)), int(m.group(3)), today)
        if dt:
            yield m.start(), 2, dt


def extract_document_date(text: str, today: date | None = None) -> str | None:
    """Renvoie la date du courrier au format 'YYYY-MM-DD', ou None."""
    if not text:
        return None
    today = today or date.today()

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    header = "\n".join(lines[:_HEADER_LINES])[:_HEADER_CHARS]

    found = list(_candidates(header, today))
    if not found:
        return None

    # la date d'un courrier est celle placée le plus haut dans l'en-tête ;
    # à position égale, on préfère la forme la moins ambiguë (texte > ISO > num.)
    found.sort(key=lambda t: (t[0], t[1]))
    return found[0][2].isoformat()
