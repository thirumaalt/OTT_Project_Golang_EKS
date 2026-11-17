"""
search-service — semantic ("search by meaning") over the MyFlix catalogue.

  media + tags (main DB, read-only)  ->  text doc  ->  embedding (fastembed, CPU)
                                                          |
                          media_embeddings (own pgvector DB, cosine / HNSW)

The main database is only ever READ. Vectors live in a separate Postgres with the
pgvector extension, so the main DB image/data never has to change.
"""
import hashlib
import logging
import os
import threading
import time
from contextlib import asynccontextmanager

import psycopg
from fastapi import FastAPI, HTTPException, Query
from fastembed import TextEmbedding
from pgvector.psycopg import register_vector
from psycopg_pool import ConnectionPool

log = logging.getLogger("search-service")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

MAIN_DSN = os.environ["DATABASE_URL"]
VECTOR_DSN = os.environ["VECTOR_DATABASE_URL"]
MODEL_NAME = os.getenv("EMBED_MODEL", "BAAI/bge-small-en-v1.5")  # 384 dimensions
DIM = 384
INDEX_INTERVAL = int(os.getenv("INDEX_INTERVAL_SECONDS", "300"))
BATCH = 16

state = {"model": None, "main": None, "vec": None}
embed_lock = threading.Lock()   # one ONNX call at a time keeps CPU use predictable
index_lock = threading.Lock()   # never run two indexing passes at once


# ── schema ────────────────────────────────────────────────────────────────────
def init_vector_schema():
    with psycopg.connect(VECTOR_DSN, autocommit=True) as c:
        c.execute("CREATE EXTENSION IF NOT EXISTS vector")
        c.execute(
            f"""CREATE TABLE IF NOT EXISTS media_embeddings (
                  media_id     bigint PRIMARY KEY,
                  content_hash text   NOT NULL,
                  embedding    vector({DIM}) NOT NULL,
                  updated_at   timestamptz NOT NULL DEFAULT now())"""
        )
        c.execute(
            "CREATE INDEX IF NOT EXISTS media_embeddings_hnsw "
            "ON media_embeddings USING hnsw (embedding vector_cosine_ops)"
        )


# ── documents ─────────────────────────────────────────────────────────────────
def build_doc(r):
    parts = [r["title"] or ""]
    if r["media_type"]:
        parts.append("TV series" if r["media_type"] == "tv" else "Movie")
    if r["genre"]:
        parts.append("Genres: " + r["genre"])
    if r["description"]:
        parts.append(r["description"])
    if r["tags"]:
        parts.append("Themes: " + r["tags"])
    if r["director"]:
        parts.append("Directed by " + r["director"])
    if r["cast"]:
        parts.append("Starring " + r["cast"])
    return ". ".join(p for p in parts if p)


def fetch_media_docs():
    with state["main"].connection() as c:
        cur = c.execute(
            """SELECT m.id, m.title, m.genre, m.description, m."cast" AS cast, m.director,
                      m.media_type, COALESCE(string_agg(t.name, ', '), '') AS tags
               FROM media m LEFT JOIN tags t ON t.media_id = m.id
               GROUP BY m.id"""
        )
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def doc_hash(text):
    return hashlib.sha256((MODEL_NAME + "\n" + text).encode()).hexdigest()


# ── indexing ──────────────────────────────────────────────────────────────────
def index_missing():
    """Embed new/changed titles, drop vectors of deleted ones. Returns counts."""
    if not index_lock.acquire(blocking=False):
        return {"skipped": "indexing already running"}
    try:
        docs = {r["id"]: build_doc(r) for r in fetch_media_docs()}
        with state["vec"].connection() as c:
            existing = dict(c.execute("SELECT media_id, content_hash FROM media_embeddings").fetchall())
            stale = [i for i in existing if i not in docs]
            if stale:
                c.execute("DELETE FROM media_embeddings WHERE media_id = ANY(%s)", (stale,))
            todo = [(i, t, doc_hash(t)) for i, t in docs.items() if existing.get(i) != doc_hash(t)]
            for s in range(0, len(todo), BATCH):
                chunk = todo[s : s + BATCH]
                with embed_lock:
                    vecs = list(state["model"].embed([t for _, t, _ in chunk]))
                for (mid, _, h), v in zip(chunk, vecs):
                    c.execute(
                        """INSERT INTO media_embeddings (media_id, content_hash, embedding)
                           VALUES (%s, %s, %s)
                           ON CONFLICT (media_id) DO UPDATE
                             SET content_hash = EXCLUDED.content_hash,
                                 embedding = EXCLUDED.embedding, updated_at = now()""",
                        (mid, h, v),
                    )
            c.commit()
        res = {"embedded": len(todo), "removed": len(stale), "total": len(docs)}
        if todo or stale:
            log.info("index pass: %s", res)
        return res
    finally:
        index_lock.release()


def index_loop():
    while True:
        try:
            index_missing()
        except Exception:  # never let the loop die (DB restarts etc.)
            log.exception("index pass failed")
        time.sleep(INDEX_INTERVAL)


# ── app ───────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app):
    log.info("loading model %s", MODEL_NAME)
    state["model"] = TextEmbedding(MODEL_NAME)
    init_vector_schema()
    state["main"] = ConnectionPool(MAIN_DSN, min_size=1, max_size=4, kwargs={"autocommit": True}, open=True)
    state["vec"] = ConnectionPool(VECTOR_DSN, min_size=1, max_size=4, configure=register_vector, open=True)
    threading.Thread(target=index_loop, daemon=True).start()
    yield
    state["main"].close()
    state["vec"].close()


app = FastAPI(title="search-service", lifespan=lifespan)


@app.get("/health")
@app.get("/actuator/health")
def health():
    if state["model"] is None:
        raise HTTPException(503, "model loading")
    return {"status": "UP"}


@app.get("/api/search/semantic")
def semantic(q: str = Query(..., min_length=2, max_length=200), limit: int = Query(12, ge=1, le=50)):
    with embed_lock:
        qv = next(iter(state["model"].query_embed(q)))
    with state["vec"].connection() as c:
        hits = c.execute(
            """SELECT media_id, 1 - (embedding <=> %s) AS score
               FROM media_embeddings ORDER BY embedding <=> %s LIMIT %s""",
            (qv, qv, limit),
        ).fetchall()
    if not hits:
        return []
    ids = [h[0] for h in hits]
    with state["main"].connection() as c:
        cur = c.execute(
            """SELECT id, title, genre, media_type, media_path, poster_url, rating, release_year
               FROM media WHERE id = ANY(%s)""",
            (ids,),
        )
        rows = {r[0]: r for r in cur.fetchall()}
    out = []
    for mid, score in hits:  # keep vector-distance order
        r = rows.get(mid)
        if r:  # media row may have been deleted since indexing
            out.append({
                "id": r[0], "title": r[1], "genre": r[2] or "", "mediaType": r[3] or "",
                "mediaPath": r[4] or "", "posterUrl": r[5] or "", "rating": float(r[6] or 0),
                "releaseYear": r[7] or 0, "score": round(float(score), 4),
            })
    return out


@app.post("/api/search/reindex", status_code=202)
def reindex():
    threading.Thread(target=index_missing, daemon=True).start()
    return {"status": "started"}


@app.get("/api/search/status")
def status():
    with state["vec"].connection() as c:
        indexed = c.execute("SELECT count(*) FROM media_embeddings").fetchone()[0]
    with state["main"].connection() as c:
        total = c.execute("SELECT count(*) FROM media").fetchone()[0]
    return {"indexed": indexed, "media": total, "model": MODEL_NAME}
