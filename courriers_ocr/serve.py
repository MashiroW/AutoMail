"""Point d'entrée du service web : `python -m courriers_ocr.serve`.

Lit `host` / `port` depuis la configuration (config.toml ou variables d'env),
puis lance uvicorn. Évite d'avoir à répéter le port dans l'unité systemd.
"""

from __future__ import annotations

import uvicorn

from .app import create_app
from .config import Config


def main() -> None:
    cfg = Config.load()
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, log_level="info")


if __name__ == "__main__":
    main()
