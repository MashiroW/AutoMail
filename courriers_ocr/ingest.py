"""Pipeline de traitement d'un PDF (première passe + retry des échecs)."""

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


# --------------------------------------------------------------------------- #
#  Première passe (fichier arrivé dans l'inbox)                               #
# --------------------------------------------------------------------------- #
def process_one_file(conn: sqlite3.Connection, cfg: Config, src: Path) -> int | None:
    """Traite un fichier de l'inbox. Renvoie l'id du document créé (ou None)."""
    original_filename = src.name
    log.info("traitement de %s", original_filename)

    sha = None
    tmp_out = cfg.tmp_dir / f"{uuid.uuid4().hex}.pdf"
    tmp_txt = tmp_out.with_suffix(".txt")

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

        # un ancien enregistrement en corbeille du même hash bloquerait
        # l'insertion (UNIQUE sha256) : on le purge
        db.purge_deleted_by_sha(conn, sha)

        result, text, page_count, doc_date, lang_guess = _ocr_and_extract(
            cfg, src, tmp_out, tmp_txt, cfg.ocr_languages
        )

        doc_id = db.insert_document(
            conn,
            sha256=sha,
            original_filename=original_filename,
            bytes=src.stat().st_size,
            page_count=page_count,
            document_date=doc_date,
            document_date_source="auto" if doc_date else None,
            title=Path(original_filename).stem,
            ocr_status=result.status,
            ocr_language=result.language,
            lang_guess=lang_guess,
        )

        yyyy, mm = _year_month(doc_date)
        base = f"{sha[:8]}_{safe_name(Path(original_filename).stem)}.pdf"
        orig_dest = _unique(cfg.originals_dir / yyyy / mm / base)
        ocr_dest = _unique(cfg.ocr_dir / yyyy / mm / base)
        text_dest = cfg.text_dir / f"{doc_id}.txt"
        thumb_dest = cfg.thumbnails_dir / f"{doc_id}.jpg"
        for p in (orig_dest, ocr_dest):
            p.parent.mkdir(parents=True, exist_ok=True)

        has_thumb = make_thumbnail(tmp_out, thumb_dest, cfg.thumbnail_width)
        text_dest.write_text(text, encoding="utf-8")
        shutil.move(str(src), str(orig_dest))
        shutil.move(str(tmp_out), str(ocr_dest))

        db.update_document(
            conn, doc_id,
            original_path=rel(cfg, orig_dest),
            ocr_path=rel(cfg, ocr_dest),
            text_path=rel(cfg, text_dest),
            thumbnail_path=rel(cfg, thumb_dest) if has_thumb else None,
        )
        db.set_fts(conn, doc_id, text, Path(original_filename).stem, None)
        log.info("#%s indexé — %s p., date=%s, statut=%s",
                 doc_id, page_count, doc_date or "?", result.status)
        return doc_id

    except Exception as exc:  # noqa: BLE001
        return _handle_failure(conn, cfg, src, original_filename, sha, exc)
    finally:
        for p in (tmp_out, tmp_txt):
            p.unlink(missing_ok=True)


def _handle_failure(conn, cfg: Config, src: Path, original_filename: str,
                    sha: str | None, exc: Exception) -> int | None:
    detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    if isinstance(exc, OcrError):
        detail = f"{exc}\n\n{detail}"
    log.error("échec sur %s : %s", original_filename, exc)

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
            conn,
            sha256=sha,
            original_filename=original_filename,
            original_path=rel(cfg, failed_pdf) if failed_pdf.exists() else None,
            title=Path(original_filename).stem,
            ocr_status="failed",
            ocr_attempts=1,
            last_attempt_at=db.now_iso(),
            notes=str(exc)[:500],
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

        yyyy, mm = _year_month(doc_date)
        base = f"{safe_name(Path(doc['original_filename']).stem)}.pdf"
        orig_dest = _unique(cfg.originals_dir / yyyy / mm / base)
        ocr_dest = _unique(cfg.ocr_dir / yyyy / mm / base)
        text_dest = cfg.text_dir / f"{doc_id}.txt"
        thumb_dest = cfg.thumbnails_dir / f"{doc_id}.jpg"
        for p in (orig_dest, ocr_dest):
            p.parent.mkdir(parents=True, exist_ok=True)

        has_thumb = make_thumbnail(tmp_out, thumb_dest, cfg.thumbnail_width)
        text_dest.write_text(text, encoding="utf-8")
        shutil.move(str(src), str(orig_dest))
        shutil.move(str(tmp_out), str(ocr_dest))
        # retire le .log de l'échec précédent
        src.with_suffix(src.suffix + ".log").unlink(missing_ok=True)

        keep_date = doc["document_date_source"] == "manual"
        db.update_document(
            conn, doc_id,
            original_path=rel(cfg, orig_dest),
            ocr_path=rel(cfg, ocr_dest),
            text_path=rel(cfg, text_dest),
            thumbnail_path=rel(cfg, thumb_dest) if has_thumb else None,
            page_count=page_count,
            ocr_status=result.status,
            ocr_language=result.language,
            lang_guess=lang_guess,
            ocr_attempts=attempts,
            last_attempt_at=db.now_iso(),
            notes=None,
            **({} if keep_date else {
                "document_date": doc_date,
                "document_date_source": "auto" if doc_date else None,
            }),
        )
        db.set_fts(conn, doc_id, text, doc["title"], doc["correspondent"])
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
