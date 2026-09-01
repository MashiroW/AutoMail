"""Fixtures partagées : configuration jetable + OCR simulé."""

from __future__ import annotations

from pathlib import Path

import pytest

from courriers_ocr import db
from courriers_ocr.config import Config

FAKE_PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


@pytest.fixture
def cfg(tmp_path: Path) -> Config:
    c = Config(
        data_dir=tmp_path / "data",
        ocr_languages="fra",
        stable_checks=1,
        poll_interval_seconds=1,
        fake_ocr=True,
    )
    c.ensure_dirs()
    return c


@pytest.fixture
def conn(cfg: Config):
    con = db.connect(cfg.db_path)
    db.init_db(con)
    yield con
    con.close()


@pytest.fixture
def drop_letter(cfg: Config):
    """Écrit inbox/<name>.pdf (+ .txt = texte OCR simulé) et renvoie le chemin."""
    def _drop(name: str, text: str, pdf_bytes: bytes = FAKE_PDF) -> Path:
        pdf = cfg.inbox / f"{name}.pdf"
        pdf.write_bytes(pdf_bytes)
        (cfg.inbox / f"{name}.txt").write_text(text, encoding="utf-8")
        return pdf
    return _drop


@pytest.fixture
def ingest(cfg: Config):
    """Lance un passage complet du worker (scan + traitement)."""
    from courriers_ocr.worker import run

    def _run():
        run(cfg, once=True)
    return _run


@pytest.fixture
def client(cfg: Config):
    from fastapi.testclient import TestClient
    from courriers_ocr.app import create_app

    with TestClient(create_app(cfg)) as c:
        yield c
