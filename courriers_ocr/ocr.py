"""Appel d'ocrmypdf (ou mode simulé pour le développement)."""

from __future__ import annotations

import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import Config
from .extract import extract_text_fallback

log = logging.getLogger(__name__)


class OcrError(RuntimeError):
    pass


@dataclass
class OcrResult:
    status: str          # 'ok' | 'skipped-has-text'
    language: str
    stdout: str = ""
    stderr: str = ""


def run_ocr(
    src_pdf: Path,
    out_pdf: Path,
    sidecar_txt: Path,
    languages: str,
    cfg: Config,
) -> OcrResult:
    """Produit `out_pdf` (PDF cherchable) et `sidecar_txt` (texte OCR)."""
    if cfg.fake_ocr:
        return _fake_ocr(src_pdf, out_pdf, sidecar_txt, languages)

    cmd = [
        "ocrmypdf",
        "--language", languages,
        "--output-type", cfg.ocr_output_type,
        "--sidecar", str(sidecar_txt),
    ]
    if cfg.ocr_skip_text:
        cmd.append("--skip-text")
    cmd += list(cfg.ocr_extra_args)
    cmd += [str(src_pdf), str(out_pdf)]

    log.info("ocrmypdf %s", " ".join(cmd[1:]))
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=cfg.ocr_timeout_seconds,
        )
    except FileNotFoundError as exc:
        raise OcrError(
            "ocrmypdf introuvable — installez-le (apt install ocrmypdf) "
            "ou activez fake_ocr pour le développement."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise OcrError(f"OCR interrompu après {cfg.ocr_timeout_seconds}s") from exc

    if proc.returncode == 0:
        return OcrResult("ok", languages, proc.stdout, proc.stderr)

    # code 6 : le PDF contient déjà du texte et --skip-text n'était pas actif
    if proc.returncode == 6:
        shutil.copyfile(src_pdf, out_pdf)
        sidecar_txt.write_text(extract_text_fallback(out_pdf), encoding="utf-8")
        return OcrResult("skipped-has-text", languages, proc.stdout, proc.stderr)

    raise OcrError(
        f"ocrmypdf a échoué (code {proc.returncode})\n"
        f"{proc.stderr.strip()[-2000:]}"
    )


def _fake_ocr(src_pdf: Path, out_pdf: Path, sidecar_txt: Path,
              languages: str) -> OcrResult:
    """Mode dev : copie le PDF, prend le texte d'un .txt voisin s'il existe."""
    shutil.copyfile(src_pdf, out_pdf)

    sibling = src_pdf.with_suffix(".txt")
    if sibling.is_file():
        text = sibling.read_text(encoding="utf-8", errors="replace")
    else:
        text = extract_text_fallback(src_pdf) or f"[FAKE OCR] {src_pdf.stem}"
    sidecar_txt.write_text(text, encoding="utf-8")
    return OcrResult("ok", languages, stdout="fake-ocr")
