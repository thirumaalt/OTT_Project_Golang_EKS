import os
import logging
import tempfile
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
from transcoder import transcode_to_hls
from pathlib import Path
from file_watcher import FileWatcherService
from kafka_consumer import start_kafka_consumer
from prometheus_client import generate_latest, CONTENT_TYPE_LATEST
from fastapi.responses import Response

# Logging Setup
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Transcoding Service", version="1.0.0")

# Configuration
STORAGE_TYPE   = os.getenv("STORAGE_TYPE",    "local").lower()
MEDIA_DIR      = os.getenv("MEDIA_DATA_DIR",  "/media")
HLS_DIR        = os.getenv("HLS_OUTPUT_DIR",  "/media/hls")
STORAGE_PATH = os.getenv("STORAGE_PATH",  "ott-media-raw")
KAFKA_BROKERS  = os.getenv("KAFKA_BROKERS",   "")   # empty = Kafka disabled

logger.info(f"Transcoding Service initialized: storage_type={STORAGE_TYPE}")

# Initialize File Watcher (for local storage only)
watcher = None
if STORAGE_TYPE == "local":
    watcher = FileWatcherService(MEDIA_DIR, HLS_DIR)

def _make_standalone_queue():
    """
    For S3-only mode there is no FileWatcherService, but we still need a queue
    so the Kafka consumer has somewhere to put jobs. Create a minimal watcher
    that is started in S3 mode purely to run the worker thread.
    """
    global watcher
    if watcher is None:
        watcher = FileWatcherService(MEDIA_DIR, HLS_DIR)
        # Don't call watcher.start() — that would launch the file-system observer.
        # Instead, just boot the worker thread directly.
        import threading, time
        from file_watcher import TranscodeQueue
        watcher.running = True
        watcher.worker_thread = threading.Thread(
            target=watcher._process_queue, daemon=True, name="transcode-worker"
        )
        watcher.worker_thread.start()
        logger.info("Standalone transcode worker started for S3/Kafka mode")
    return watcher.queue


class TranscodeRequest(BaseModel):
    """Request to transcode a specific file."""
    path: str  # Path relative to MEDIA_DIR (for local) or S3 key (for S3)
    category: str = None  # Movies, TvShows, Anime


@app.on_event("startup")
async def startup_event():
    """Start file watcher and (optionally) Kafka consumer on application startup."""
    if STORAGE_TYPE == "local":
        logger.info("Starting File Watcher Service...")
        watcher.start()
    else:
        logger.info(f"Using S3 storage ({STORAGE_PATH}), file watcher not needed")

    # Start Kafka consumer regardless of storage type — it feeds the same queue
    if KAFKA_BROKERS:
        logger.info(f"Starting Kafka consumer thread (brokers={KAFKA_BROKERS})...")
        start_kafka_consumer(
            queue=watcher.queue if watcher else _make_standalone_queue(),
            media_dir=MEDIA_DIR,
            hls_dir=HLS_DIR,
            storage_type=STORAGE_TYPE,
        )
    else:
        logger.info("KAFKA_BROKERS not set — running without Kafka (manual/file-watcher mode only)")


@app.on_event("shutdown")
async def shutdown_event():
    """Stop file watcher on application shutdown."""
    if watcher:
        logger.info("Stopping File Watcher Service...")
        watcher.stop()


@app.get("/health")

@app.get("/metrics")
async def metrics():
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST,
    )
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "storage_type": STORAGE_TYPE,
        "bucket": STORAGE_PATH if STORAGE_TYPE == "s3" else MEDIA_DIR
    }


@app.post("/transcode")
def trigger_transcode(req: TranscodeRequest, background_tasks: BackgroundTasks):
    """
    Triggers transcoding for a specific file manually.
    
    For local storage:
      - path: relative path from MEDIA_DATA_DIR (e.g., "Movies/MyMovie.mp4")
    
    For S3 storage:
      - path: S3 key (e.g., "Movies/MyMovie.mp4")
    """
    try:
        if STORAGE_TYPE == "local":
            # Local storage: validate file exists
            input_full_path = Path(MEDIA_DIR) / req.path
            
            if not input_full_path.exists():
                raise HTTPException(status_code=404, detail="File not found in local storage")
            
            # Create unique ID for output directory
            file_id = req.path.replace("/", "_").replace("\\", "_").replace(".", "_")
            output_dir = Path(HLS_DIR) / file_id
            
            # Add to watcher queue
            watcher.queue.add(str(input_full_path))
            
            logger.info(f"Queued local file for transcoding: {req.path}")
        
        else:  # S3 storage
            # For S3, we need to process in background
            file_id = req.path.replace("/", "_")
            
            # For local temporary output (during transcoding)
            temp_output_dir = tempfile.mkdtemp(prefix="hls_")
            s3_key_prefix = f"hls/{file_id}"
            
            # Trigger background task
            background_tasks.add_task(
                transcode_to_hls,
                input_path=req.path,
                output_dir=temp_output_dir,
                s3_key_prefix=s3_key_prefix
            )
            
            logger.info(f"Queued S3 file for transcoding: {req.path} -> {s3_key_prefix}")
        
        return {
            "status": "queued",
            "file_id": file_id,
            "storage_type": STORAGE_TYPE,
            "message": "File queued for transcoding"
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error triggering transcode: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/queue/status")
def get_queue_status():
    """Get current transcoding queue status."""
    if STORAGE_TYPE == "local" and watcher:
        return {
            "storage_type": STORAGE_TYPE,
            "queue": watcher.queue.get_status()
        }
    else:
        return {
            "storage_type": STORAGE_TYPE,
            "message": "Queue status not available for S3 storage (async processing)"
        }


