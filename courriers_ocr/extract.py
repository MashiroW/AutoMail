"""Utilitaires PDF : texte de repli, nombre de pages, vignette, langue probable."""

from __future__ import annotations

import logging
import re
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)


def _run(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        log.debug("commande indisponible ou trop lente : %s (%s)", cmd[0], exc)
        return None


def extract_text_fallback(pdf_path: Path) -> str:
    """Texte via `pdftotext` (poppler). Chaîne vide si l'outil manque."""
    proc = _run(["pdftotext", "-layout", str(pdf_path), "-"])
    if proc and proc.returncode == 0:
        return proc.stdout
    return ""


def pdf_page_count(pdf_path: Path) -> int:
    proc = _run(["pdfinfo", str(pdf_path)])
    if proc and proc.returncode == 0:
        m = re.search(r"^Pages:\s+(\d+)", proc.stdout, re.MULTILINE)
        if m:
            return int(m.group(1))
    # repli grossier : compter les objets /Type /Page dans les octets bruts
    try:
        raw = pdf_path.read_bytes()
        n = len(re.findall(rb"/Type\s*/Page[^s]", raw))
        return n or 0
    except OSError:
        return 0


def make_thumbnail(pdf_path: Path, out_jpg: Path, width: int) -> bool:
    """Première page -> JPEG. Renvoie True si la vignette a été créée."""
    out_jpg.parent.mkdir(parents=True, exist_ok=True)
    stem = out_jpg.with_suffix("")  # pdftoppm ajoute l'extension
    proc = _run([
        "pdftoppm", "-jpeg", "-f", "1", "-l", "1", "-singlefile",
        "-scale-to-x", str(width), "-scale-to-y", "-1",
        str(pdf_path), str(stem),
    ])
    if proc and proc.returncode == 0 and out_jpg.is_file():
        return True
    log.info("vignette non générée pour %s (pdftoppm absent ou en échec)", pdf_path.name)
    return False


def clean_text(text: str) -> str:
    if not text:
        return ""
    text = text.replace("\x0c", "\n").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# --- indice de langue (affichage seulement) -------------------------------- #
_STOP = {
    "fr": {"le", "la", "les", "de", "des", "et", "un", "une", "vous", "nous",
           "votre", "pour", "que", "qui", "avec", "dans", "sur", "est", "au",
           "aux", "par", "monsieur", "madame", "courrier"},
    "de": {"der", "die", "das", "und", "sie", "ihre", "ihren", "mit", "von",
           "den", "dem", "ein", "eine", "nicht", "auch", "wir", "für", "ist",
           "sehr", "geehrte", "sehr", "herr", "frau"},
    "en": {"the", "and", "you", "your", "for", "with", "this", "that", "have",
           "please", "dear", "we", "is", "are", "to", "of"},
}


def guess_language(text: str) -> str | None:
    words = re.findall(r"[a-zA-ZäöüÄÖÜßàâçéèêëîïôûùüÿœ]+", (text or "").lower())
    if len(words) < 20:
        return None
    counts = {lang: sum(1 for w in words if w in stop) for lang, stop in _STOP.items()}
    best = max(counts, key=counts.get)
    if counts[best] == 0:
        return None
    return best
