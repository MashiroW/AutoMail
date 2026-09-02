"""Extraction heuristique de la date d'un courrier.

On cherche d'abord dans l'en-tête (là où la date est presque toujours :
« Paris, le 12 mars 2024 », « 12/03/2024 », « Rechnung vom 03.12.2024 »…),
puis, si rien, dans tout le texte.

Tolérant au bruit OCR : chiffres confondus (O→0, l/I→1, S→5…), espaces parasites
autour des séparateurs, années sur 2 chiffres en toutes lettres.
Aucune dépendance externe : parsing fait à la main, déterministe et testable.
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
    # français
    "janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
    "juillet": 7, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11,
    "decembre": 12,
    "janv": 1, "fev": 2, "fevr": 2, "avr": 4, "juil": 7, "juill": 7,
    "sept": 9, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    # allemand
    "januar": 1, "februar": 2, "maerz": 3, "marz": 3, "april": 4, "juni": 6,
    "juli": 7, "august": 8, "oktober": 10, "dezember": 12,
    "jan": 1, "feb": 2, "mrz": 3, "mar": 3, "jun": 6, "jul": 7, "aug": 8,
    "okt": 10, "dez": 12,
    # anglais
    "january": 1, "february": 2, "march": 3, "june": 6, "july": 7,
    "september": 9, "october": 10, "november": 11, "december": 12,
    "feb.": 2,
}
_MONTH_ALT = "|".join(sorted((re.escape(m) for m in _MONTHS), key=len, reverse=True))

# corrections de confusions OCR, appliquées seulement aux fragments numériques
_DIGIT_FIX = str.maketrans({
    "O": "0", "o": "0", "Q": "0", "D": "0",
    "l": "1", "I": "1", "|": "1", "L": "1",
    "S": "5", "s": "5", "B": "8", "Z": "2", "z": "2", "g": "9", "T": "7",
})

_DSEP = r"\s*[/.\-– ]\s*"          # séparateur : / . - – ou espace
_D1 = r"([0-9OoQDlI|LSBZzgT]{1,2})"     # 1-2 « chiffres » (bruit OCR inclus)
_D2 = r"([0-9OoQDlI|LSBZzgT]{2,4})"

_RE_TEXT = re.compile(
    r"\b([0-9OoQDlI|L]{1,2})(?:\s*(?:er|re|e|eme|ere|ste|te|nd|rd|th|°))?"
    r"[.,]?\s+(" + _MONTH_ALT + r")\.?\s*[.,]?\s+([0-9OoQDlI|L]{2,4})\b",
    re.IGNORECASE,
)
_RE_TEXT_REV = re.compile(       # « March 12, 2024 » / « 12. März 2024 » déjà couvert
    r"\b(" + _MONTH_ALT + r")\.?\s+([0-9OoQDlI|L]{1,2})(?:st|nd|rd|th)?,?\s+"
    r"([0-9OoQDlI|L]{4})\b",
    re.IGNORECASE,
)
_RE_ISO = re.compile(r"\b([0-9OoQDlI|L]{4})" + _DSEP + _D1 + _DSEP + _D1 + r"\b")
_RE_NUM = re.compile(r"\b" + _D1 + _DSEP + _D1 + _DSEP + _D2 + r"\b")


def _strip_accents(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )


def _int(s: str) -> int:
    return int(s.translate(_DIGIT_FIX))


def _year(v: int) -> int:
    if v > 99:
        return v
    return 2000 + v if v < 80 else 1900 + v


def _valid(y: int, m: int, d: int, today: date) -> date | None:
    if not (1 <= m <= 12 and 1 <= d <= 31):
        return None
    try:
        dt = date(y, m, d)
    except ValueError:
        return None
    if dt.year < today.year - 25 or dt > date(today.year + 1, today.month, 1):
        return None
    return dt


def _candidates(window: str, today: date):
    """(position, priorité, date) — priorité 0 = forme la plus fiable."""
    norm = _strip_accents(window)

    for m in _RE_TEXT.finditer(norm):
        mon = _MONTHS.get(m.group(2).lower().rstrip("."))
        if mon:
            dt = _valid(_year(_int(m.group(3))), mon, _int(m.group(1)), today)
            if dt:
                yield m.start(), 0, dt
    for m in _RE_TEXT_REV.finditer(norm):
        mon = _MONTHS.get(m.group(1).lower().rstrip("."))
        if mon:
            dt = _valid(_year(_int(m.group(3))), mon, _int(m.group(2)), today)
            if dt:
                yield m.start(), 0, dt
    for m in _RE_ISO.finditer(norm):
        dt = _valid(_int(m.group(1)), _int(m.group(2)), _int(m.group(3)), today)
        if dt:
            yield m.start(), 1, dt
    for m in _RE_NUM.finditer(norm):
        a, b, c = _int(m.group(1)), _int(m.group(2)), _year(_int(m.group(3)))
        day, month = (b, a) if a > 12 and b <= 12 else (a, b)  # défaut JJ/MM
        dt = _valid(c, month, day, today)
        if dt:
            yield m.start(), 2, dt


def _pick(window: str, today: date) -> str | None:
    found = list(_candidates(window, today))
    if not found:
        return None
    # la plus haute dans la page d'abord ; à égalité, la forme la moins ambiguë
    found.sort(key=lambda t: (t[0], t[1]))
    return found[0][2].isoformat()


def extract_document_date(text: str, today: date | None = None) -> str | None:
    """Renvoie la date du courrier au format 'YYYY-MM-DD', ou None."""
    if not text:
        return None
    today = today or date.today()

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    header = "\n".join(lines[:_HEADER_LINES])[:_HEADER_CHARS]

    result = _pick(header, today)
    if result is None:
        result = _pick(text[:_FULLTEXT_CHARS], today)

    log.debug("date extraite=%s (sur %d lignes)", result, len(lines))
    return result
