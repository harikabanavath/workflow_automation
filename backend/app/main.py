from pathlib import Path

import psycopg
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .settings import settings
from .api import rbac_middleware, router


app = FastAPI(title="Workflow Automation API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.middleware("http")(rbac_middleware)
app.include_router(router)


@app.get("/health", tags=["system"])
def health() -> dict[str, str]:
    return {"status": "ok", "service": "workflow-api"}


@app.get("/health/db", tags=["system"])
def database_health() -> dict[str, str]:
    with psycopg.connect(settings.database_url, connect_timeout=3) as connection:
        connection.execute("SELECT 1")
    return {"status": "ok", "database": "reachable"}


def run_migrations() -> None:
    migration = Path("/db/migrations/001_initial_schema.sql")
    if not migration.exists():
        return
    with psycopg.connect(settings.database_url) as connection:
        connection.execute(migration.read_text(encoding="utf-8"))
        connection.commit()


@app.on_event("startup")
def startup() -> None:
    run_migrations()
