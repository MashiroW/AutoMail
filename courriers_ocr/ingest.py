"""Pipeline de traitement d'un PDF : enregistrement immédiat puis OCR."""

from __future__ import annotations

import hashlib
import logging
import re
import shutil
import sqlite3
import traceback
import uuid
from datetime import date, datetime
from pathlib import Path

from .config import Config
from . import db
from .dates import extract_document_date
from .extract import (
    clean_text,
    extract_text_fallback,
    guess_language,
    make_thumbnail,
    pdf_page_count,
)
from .ocr import OcrError, run_ocr

log = logging.getLogger(__name__)

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_name(name: str) -> str:
    name = _SAFE.sub("_", name).strip("_.")
    return name or "courrier"


def rel(cfg: Config, p: Path) -> str:
    return str(p.resolve().relative_to(cfg.data_dir.resolve()))


def abspath(cfg: Config, relpath: str) -> Path:
    return (cfg.data_dir / relpath).resolve()


def _year_month(iso_date: str | None) -> tuple[str, str]:
    if iso_date:
        try:
            d = datetime.strptime(iso_date, "%Y-%m-%d").date()
            return f"{d.year:04d}", f"{d.month:02d}"
        except ValueError:
            pass
    today = date.today()
    return f"{today.year:04d}", f"{today.month:02d}"


_TRASH_KEYS = (
    ("original_path", "original"),
    ("ocr_path", "ocr"),
    ("thumbnail_path", "thumb"),
    ("text_path", "text"),
)


def move_to_trash(cfg: Config, row: dict) -> None:
    """Déplace les fichiers d'un courrier vers data/trash/<id>/<role>/."""
    base = cfg.trash_dir / str(row["id"])
    for key, short in _TRASH_KEYS:
        if row[key]:
            p = abspath(cfg, row[key])
            if p.is_file():
                dest = base / short / p.name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(p), str(dest))


def restore_from_trash(cfg: Config, row: dict) -> str:
    """Remet les fichiers en place. Renvoie le texte OCR (pour réindexer)."""
    base = cfg.trash_dir / str(row["id"])
    for key, short in _TRASH_KEYS:
        if row[key]:
            src = base / short / Path(row[key]).name
            if src.is_file():
                dst = abspath(cfg, row[key])
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
    text = ""
    if row["text_path"]:
        tp = abspath(cfg, row["text_path"])
        if tp.is_file():
            text = tp.read_text(encoding="utf-8", errors="replace")
    shutil.rmtree(base, ignore_errors=True)
    return text


def purge_trash_dir(cfg: Config, doc_id: int) -> None:
    shutil.rmtree(cfg.trash_dir / str(doc_id), ignore_errors=True)


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    stem, suffix, parent = path.stem, path.suffix, path.parent
    i = 2
    while True:
        cand = parent / f"{stem}_{i}{suffix}"
        if not cand.exists():
            return cand
        i += 1


def _ocr_and_extract(cfg: Config, src: Path, tmp_out: Path, tmp_txt: Path,
                     languages: str):
    """OCR + extraction. Renvoie (result, text, page_count, doc_date, lang_guess)."""
    result = run_ocr(src, tmp_out, tmp_txt, languages, cfg)
    text = ""
    if tmp_txt.is_file():
        text = tmp_txt.read_text(encoding="utf-8", errors="replace")
    if len(text.strip()) < 3:
        text = extract_text_fallback(tmp_out)
    text = clean_text(text)
    page_count = pdf_page_count(tmp_out) or pdf_page_count(src)
    return result, text, page_count, extract_document_date(text), guess_language(text)


def _folder_of(rel_original: str | None) -> tuple[str, str]:
    """(AAAA, MM) depuis 'originals/AAAA/MM/...' — sinon le mois courant."""
    if rel_original:
        parts = Path(rel_original).parts
        if len(parts) >= 3 and parts[1].isdigit() and parts[2].isdigit():
            return parts[1], parts[2]
    return _year_month(None)


def _place_ocr_outputs(conn, cfg: Config, doc_id: int, rel_original: str | None,
                       orig_fname: str, tmp_out: Path, text: str, page_count: int,
                       doc_date: str | None, lang_guess: str | None, result,
                       *, keep_date: bool, title: str | None,
                       correspondent: str | None = None) -> None:
    """Range PDF OCR / texte / vignette d'un doc déjà enregistré et met à jour la ligne."""
    yyyy, mm = _folder_of(rel_original)
    base = f"{safe_name(Path(orig_fname).stem)}.pdf"
    ocr_dest = _unique(cfg.ocr_dir / yyyy / mm / base)
    ocr_dest.parent.mkdir(parents=True, exist_ok=True)
    text_dest = cfg.text_dir / f"{doc_id}.txt"
    thumb_dest = cfg.thumbnails_dir / f"{doc_id}.jpg"

    has_thumb = make_thumbnail(tmp_out, thumb_dest, cfg.thumbnail_width)
    text_dest.write_text(text, encoding="utf-8")
    shutil.move(str(tmp_out), str(ocr_dest))

    fields = dict(
        ocr_path=rel(cfg, ocr_dest),
        text_path=rel(cfg, text_dest),
        page_count=page_count,
        ocr_status=result.status,
        ocr_language=result.language,
        lang_guess=lang_guess,
        notes=None,
    )
    if has_thumb:
        fields["thumbnail_path"] = rel(cfg, thumb_dest)
    if not keep_date:
        fields["document_date"] = doc_date
        fields["document_date_source"] = "auto" if doc_date else None
    db.update_document(conn, doc_id, **fields)
    db.set_fts(conn, doc_id, text, title, correspondent)


# --------------------------------------------------------------------------- #
#  Phase 1 : enregistrement immédiat (le courrier devient visible / dispo)    #
# --------------------------------------------------------------------------- #
def register_file(conn: sqlite3.Connection, cfg: Config, src: Path) -> int | None:
    """Enregistre un fichier de l'inbox en statut 'pending'. Renvoie l'id (ou None)."""
    original_filename = src.name
    try:
        sha = sha256_file(src)
        existing = db.sha_exists(conn, sha)
        if existing is not None:
            dest = _unique(
                cfg.originals_dir / "duplicates"
                / f"{sha[:8]}_{safe_name(original_filename)}"
            )
            shutil.move(str(src), str(dest))
            log.info("doublon de #%s -> %s", existing, dest.name)
            return None
        db.purge_deleted_by_sha(conn, sha)

        title = Path(original_filename).stem
        doc_id = db.insert_document(
            conn, sha256=sha, original_filename=original_filename,
            bytes=src.stat().st_size, title=title, ocr_status="pending",
        )
        yyyy, mm = _year_month(None)
        base = f"{sha[:8]}_{safe_name(title)}.pdf"
        orig_dest = _unique(cfg.originals_dir / yyyy / mm / base)
        orig_dest.parent.mkdir(parents=True, exist_ok=True)
        # emmène un éventuel .txt voisin (mode fake-OCR / dépôt manuel)
        sidecar = src.with_suffix(".txt")
        if sidecar.is_file():
            shutil.move(str(sidecar), str(orig_dest.with_suffix(".txt")))
        shutil.move(str(src), str(orig_dest))
        db.update_document(conn, doc_id, original_path=rel(cfg, orig_dest))

        thumb_dest = cfg.thumbnails_dir / f"{doc_id}.jpg"
        if make_thumbnail(orig_dest, thumb_dest, cfg.thumbnail_width):
            db.update_document(conn, doc_id, thumbnail_path=rel(cfg, thumb_dest))
        db.set_fts(conn, doc_id, "", title, None)
        log.info("#%s reçu — OCR en attente", doc_id)
        return doc_id
    except Exception as exc:  # noqa: BLE001
        return _handle_failure(conn, cfg, src, original_filename, None, None, exc)


# --------------------------------------------------------------------------- #
#  Phase 2 : OCR d'un document en attente                                     #
# --------------------------------------------------------------------------- #
def ocr_pending_doc(conn: sqlite3.Connection, cfg: Config, doc_id: int) -> bool:
    doc = db.get_document(conn, doc_id, include_deleted=True)
    if not doc or not doc["original_path"]:
        return False
    src = abspath(cfg, doc["original_path"])
    if not src.is_file():
        db.update_document(conn, doc_id, ocr_status="failed", ocr_attempts=1,
                           last_attempt_at=db.now_iso(),
                           notes="fichier d'origine absent du disque")
        return False

    tmp_out = cfg.tmp_dir / f"{uuid.uuid4().hex}.pdf"
    tmp_txt = tmp_out.with_suffix(".txt")
    try:
        result, text, page_count, doc_date, lang_guess = _ocr_and_extract(
            cfg, src, tmp_out, tmp_txt, cfg.ocr_languages
        )
        _place_ocr_outputs(
            conn, cfg, doc_id, doc["original_path"], doc["original_filename"],
            tmp_out, text, page_count, doc_date, lang_guess, result,
            keep_date=(doc["document_date_source"] == "manual"),
            title=doc["title"], correspondent=doc["correspondent"],
        )
        log.info("#%s indexé — %s p., date=%s, statut=%s",
                 doc_id, page_count, doc_date or "?", result.status)
        return True
    except Exception as exc:  # noqa: BLE001
        _handle_failure(conn, cfg, src, doc["original_filename"], None, doc_id, exc)
        return False
    finally:
        for p in (tmp_out, tmp_txt):
            p.unlink(missing_ok=True)


def process_one_file(conn: sqlite3.Connection, cfg: Config, src: Path) -> int | None:
    """Enregistre puis OCRise un fichier (pratique pour les tests / --once)."""
    doc_id = register_file(conn, cfg, src)
    if doc_id is not None:
        ocr_pending_doc(conn, cfg, doc_id)
    return doc_id


def _handle_failure(conn, cfg: Config, src: Path, original_filename: str,
                    sha: str | None, doc_id: int | None,
                    exc: Exception) -> int | None:
    detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    if isinstance(exc, OcrError):
        detail = f"{exc}\n\n{detail}"
    log.error("échec sur %s : %s", original_filename, exc)

    if doc_id is not None:
        row = db.get_document(conn, doc_id, include_deleted=True)
        if row and row["original_path"]:
            p = abspath(cfg, row["original_path"])
            try:
                p.with_suffix(p.suffix + ".log").write_text(detail, encoding="utf-8")
            except OSError:
                pass
        db.update_document(conn, doc_id, ocr_status="failed", ocr_attempts=1,
                           last_attempt_at=db.now_iso(), notes=str(exc)[:500])
        return doc_id

    failed_pdf = _unique(cfg.failed_dir / safe_name(original_filename))
    try:
        if src.exists():
            shutil.move(str(src), str(failed_pdf))
        failed_pdf.with_suffix(failed_pdf.suffix + ".log").write_text(
            detail, encoding="utf-8"
        )
    except OSError:
        log.exception("impossible de déplacer le fichier en échec")
    try:
        return db.insert_document(
            conn, sha256=sha, original_filename=original_filename,
            original_path=rel(cfg, failed_pdf) if failed_pdf.exists() else None,
            title=Path(original_filename).stem, ocr_status="failed",
            ocr_attempts=1, last_attempt_at=db.now_iso(), notes=str(exc)[:500],
        )
    except sqlite3.IntegrityError:
        return None


# --------------------------------------------------------------------------- #
#  Retry automatique d'un courrier en échec                                   #
# --------------------------------------------------------------------------- #
def reprocess_failed_doc(conn: sqlite3.Connection, cfg: Config, doc: dict) -> bool:
    """Retente l'OCR sur un document en échec. True si ça a réussi cette fois."""
    doc_id = doc["id"]
    attempts = (doc["ocr_attempts"] or 0) + 1
    log.info("retry #%s (tentative %s)", doc_id, attempts)

    if not doc["original_path"]:
        db.update_document(conn, doc_id, ocr_attempts=attempts,
                           last_attempt_at=db.now_iso(),
                           notes="fichier d'origine inconnu")
        return False
    src = abspath(cfg, doc["original_path"])
    if not src.is_file():
        db.update_document(conn, doc_id, ocr_attempts=attempts,
                           last_attempt_at=db.now_iso(),
                           notes="fichier d'origine absent du disque")
        return False

    tmp_out = cfg.tmp_dir / f"{uuid.uuid4().hex}.pdf"
    tmp_txt = tmp_out.with_suffix(".txt")
    try:
        result, text, page_count, doc_date, lang_guess = _ocr_and_extract(
            cfg, src, tmp_out, tmp_txt, cfg.ocr_languages
        )
        _place_ocr_outputs(
            conn, cfg, doc_id, doc["original_path"], doc["original_filename"],
            tmp_out, text, page_count, doc_date, lang_guess, result,
            keep_date=(doc["document_date_source"] == "manual"),
            title=doc["title"], correspondent=doc["correspondent"],
        )
        db.update_document(conn, doc_id, ocr_attempts=attempts,
                           last_attempt_at=db.now_iso())
        src.with_suffix(src.suffix + ".log").unlink(missing_ok=True)
        log.info("retry #%s : réussi (statut=%s)", doc_id, result.status)
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("retry #%s : encore en échec (%s)", doc_id, exc)
        db.update_document(conn, doc_id, ocr_attempts=attempts,
                           last_attempt_at=db.now_iso(), notes=str(exc)[:500])
        return False
    finally:
        for p in (tmp_out, tmp_txt):
            p.unlink(missing_ok=True)
