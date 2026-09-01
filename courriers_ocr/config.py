"""Chargement de la configuration.

Ordre de priorité (du plus faible au plus fort) :

1. valeurs par défaut ci-dessous ;
2. fichier TOML :  $COURRIERS_CONFIG, sinon ./config.toml, sinon
   /etc/courriers-ocr/config.toml ;
3. variables d'environnement  COURRIERS_<CLÉ>  (ex. COURRIERS_PORT).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from pathlib import Path

try:  # Python >= 3.11
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib  # type: ignore

_CONFIG_SEARCH = [
    os.environ.get("COURRIERS_CONFIG"),
    "config.toml",
    "/etc/courriers-ocr/config.toml",
]

_TRUE = {"1", "true", "yes", "on", "oui"}
_FALSE = {"0", "false", "no", "off", "non"}


@dataclass
class Config:
    data_dir: Path = Path("./data")
    inbox_dir: Path | None = None
    ocr_languages: str = "fra"
    poll_interval_seconds: float = 10.0
    stable_checks: int = 2
    host: str = "0.0.0.0"
    port: int = 8080
    thumbnail_width: int = 400
    ocr_extra_args: list[str] = field(
        default_factory=lambda: ["--rotate-pages", "--deskew", "--clean"]
    )
    ocr_skip_text: bool = True
    ocr_timeout_seconds: int = 1800
    api_token: str | None = None
    cors_origins: list[str] = field(default_factory=lambda: ["*"])
    fake_ocr: bool = False

    # -- dossiers dérivés -------------------------------------------------
    @property
    def inbox(self) -> Path:
        return self.inbox_dir or (self.data_dir / "inbox")

    @property
    def originals_dir(self) -> Path:
        return self.data_dir / "originals"

    @property
    def ocr_dir(self) -> Path:
        return self.data_dir / "ocr"

    @property
    def thumbnails_dir(self) -> Path:
        return self.data_dir / "thumbnails"

    @property
    def text_dir(self) -> Path:
        return self.data_dir / "text"

    @property
    def failed_dir(self) -> Path:
        return self.data_dir / "failed"

    @property
    def trash_dir(self) -> Path:
        return self.data_dir / "trash"

    @property
    def tmp_dir(self) -> Path:
        return self.data_dir / "tmp"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "data" / "courriers.db"

    def ensure_dirs(self) -> None:
        for p in (
            self.inbox,
            self.originals_dir,
            self.originals_dir / "duplicates",
            self.ocr_dir,
            self.thumbnails_dir,
            self.text_dir,
            self.failed_dir,
            self.trash_dir,
            self.tmp_dir,
            self.db_path.parent,
        ):
            p.mkdir(parents=True, exist_ok=True)

    # -- construction ---------------------------------------------------
    @classmethod
    def load(cls, path: str | os.PathLike | None = None) -> "Config":
        data: dict = {}

        candidates = [path] if path else _CONFIG_SEARCH
        for cand in candidates:
            if cand and Path(cand).is_file():
                with open(cand, "rb") as fh:
                    data = tomllib.load(fh)
                break

        # variables d'environnement -> surcharge
        types = {f.name: f.type for f in fields(cls)}
        for name in types:
            env = os.environ.get("COURRIERS_" + name.upper())
            if env is not None:
                data[name] = env

        cfg = cls()
        for name, raw in data.items():
            if not hasattr(cfg, name):
                continue
            setattr(cfg, name, _coerce(name, raw))
        return cfg


def _coerce(name: str, raw):
    """Convertit une valeur (issue du TOML ou d'une variable d'env) vers le bon type."""
    if name in ("data_dir", "inbox_dir"):
        return Path(raw).expanduser()
    if name == "poll_interval_seconds":
        return float(raw)
    if name in ("stable_checks", "port", "thumbnail_width", "ocr_timeout_seconds"):
        return int(raw)
    if name in ("ocr_skip_text", "fake_ocr"):
        if isinstance(raw, bool):
            return raw
        return str(raw).strip().lower() in _TRUE
    if name in ("ocr_extra_args", "cors_origins"):
        if isinstance(raw, list):
            return [str(x) for x in raw]
        # chaîne d'env : séparateurs virgule ou espace
        return [x for x in str(raw).replace(",", " ").split() if x]
    if name == "api_token":
        raw = str(raw).strip()
        return raw or None
    return raw
