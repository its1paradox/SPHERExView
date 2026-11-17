"""One process is essential: comparison state and admission slots are in memory."""
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
for variable in ("SPHEREX_CACHE_DIR", "SPHEREX_STATIC_DIR", "XDG_CACHE_HOME"):
    if os.environ.get(variable):
        Path(os.environ[variable]).mkdir(parents=True, exist_ok=True)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.app.main:app", host="0.0.0.0",
                port=int(os.environ.get("PORT", "10000")), workers=1,
                timeout_keep_alive=5, limit_concurrency=32,
                timeout_graceful_shutdown=120)
