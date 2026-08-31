from __future__ import annotations

import os

import uvicorn

from voice_worker.main import app


def main() -> None:
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("NOIZZZY_API_PORT", "35592")),
        access_log=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
