"""Schémas Pydantic pour l'API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class DocumentOut(BaseModel):
    id: int
    original_filename: str
    title: str | None = None
    correspondent: str | None = None
    document_date: str | None = None
    document_date_source: str | None = None
    added_at: str
    page_count: int | None = None
    bytes: int | None = None
    ocr_status: str
    ocr_language: str | None = None
    lang_guess: str | None = None
    ocr_attempts: int = 0
    ocr_started_at: str | None = None
    ocr_seconds: float | None = None
    progress: str = "done"
    snippet: str | None = None
    has_thumbnail: bool = False
    notes: str | None = None


class SearchResponse(BaseModel):
    items: list[DocumentOut]
    total: int
    page: int
    page_size: int


class DocumentPatch(BaseModel):
    title: str | None = None
    correspondent: str | None = None
    document_date: str | None = Field(
        default=None, description="'YYYY-MM-DD' ou chaîne vide pour effacer"
    )
    notes: str | None = None
    progress: str | None = Field(default=None, examples=["todo", "ongoing", "done"])


class ReocrRequest(BaseModel):
    language: str = Field(examples=["deu", "ara", "fra+deu"])


class BulkRequest(BaseModel):
    ids: list[int]
    action: str = Field(examples=["trash", "restore", "purge", "progress"])
    value: str | None = Field(default=None, examples=["todo", "ongoing", "done"])


class StatsOut(BaseModel):
    total: int
    failed: int
    trashed: int
    reprocessing: int = 0
    pending: int = 0
    processing: int = 0
    avg_sec_per_page: float | None = None
    last_added: str | None = None
    cpu_temp_c: float | None = None
    disk_free_bytes: int
    disk_total_bytes: int


class OverviewOut(BaseModel):
    total: int
    this_month: int
    trashed: int
    disk_free_bytes: int
    disk_total_bytes: int
    cpu_temp_c: float | None = None
    by_month: list[dict]          # [{"month": "2026-01", "count": 12}, ...]
    by_progress: dict             # {"todo": n, "ongoing": n, "done": n}
    by_ocr: dict                  # {"ok": n, "pending": n, "failed": n}
