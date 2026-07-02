import os
import time
import threading
import logging
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from transcoder import transcode_to_hls

logger = logging.getLogger(__name__)

# Supported video extensions
VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.avi', '.mov', '.webm'}

class TranscodeQueue:
    def __init__(self):
        self.pending = []
        self.processing = None
        self.completed = []
        self.failed = []
        self.lock = threading.Lock()

    def add(self, file_path):
        with self.lock:
            if file_path not in self.pending and file_path != self.processing:
                self.pending.append(file_path)
                logger.info(f"Added to queue: {file_path}")

    def add_s3(self, entry: dict):
        """Add an S3 transcode job (dict with type/storage_key/file_id)."""
        with self.lock:
            key = entry.get("storage_key")
            already = any(
                (isinstance(e, dict) and e.get("storage_key") == key)
                for e in self.pending
            )
            if not already and not (isinstance(self.processing, dict) and self.processing.get("storage_key") == key):
                self.pending.append(entry)
                logger.info(f"Added S3 job to queue: {key}")

    def get_next(self):
        with self.lock:
            if self.pending:
                self.processing = self.pending.pop(0)
                return self.processing
            return None

    def mark_completed(self, file_path):
        with self.lock:
            if self.processing == file_path:
                self.processing = None
            self.completed.append(file_path)
            # Keep only last 50 completed
            if len(self.completed) > 50:
                self.completed.pop(0)

    def mark_failed(self, file_path, error):
        with self.lock:
            if self.processing == file_path:
                self.processing = None
            self.failed.append({"path": file_path, "error": str(error)})
            # Keep only last 50 failed
            if len(self.failed) > 50:
                self.failed.pop(0)

    def get_status(self):
        with self.lock:
            return {
                "pending_count": len(self.pending),
                "pending": self.pending,
                "processing": self.processing,
                "completed_count": len(self.completed),
                "failed_count": len(self.failed)
            }

class VideoHandler(FileSystemEventHandler):
    def __init__(self, queue, media_dir, hls_dir):
        self.queue = queue
        self.media_dir = Path(media_dir)
        self.hls_dir = Path(hls_dir)

    def _process_file(self, file_path):
        path = Path(file_path)
        
        # Check extension
        if path.suffix.lower() not in VIDEO_EXTENSIONS:
            return

        # Check if HLS already exists
        # Structure: /media/hls/Category_Filename_ext/
        # Input: /media/Movies/Ne Zha.mp4
        
        try:
            relative_path = path.relative_to(self.media_dir)
            # Construct HLS directory name logic matching transcoder.py (implied)
            # Usually transcoder logic is: "Movies/Ne Zha.mp4" -> "Movies_Ne Zha_mp4"
            # But let's look at how we want to store it. 
            # The transcoder.py takes input_path and output_dir.
            # Let's just add to queue and let the worker decide if it needs transcoding
            # based on the transcoder's check.
            
            # However, we want to avoid re-adding if we know it's done.
            # Let's rely on the worker to check existence to be safe and simple.
            
            self.queue.add(str(path))
            
        except ValueError:
            pass

    def on_created(self, event):
        if not event.is_directory:
            self._process_file(event.src_path)

    def on_moved(self, event):
        if not event.is_directory:
            self._process_file(event.dest_path)

class FileWatcherService:
    def __init__(self, media_dir, hls_dir):
        self.media_dirs = [d.strip() for d in media_dir.split(",") if d.strip()]
        self.hls_dir = hls_dir
        self.queue = TranscodeQueue()
        self.observer = Observer()
        self.running = False
        self.worker_thread = None

    def start(self):
        if self.running:
            return

        self.running = True
        
        # 1. Scan existing files
        for media_dir in self.media_dirs:
            logger.info(f"Scanning {media_dir} for existing videos...")
            for root, _, files in os.walk(media_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    # Skip if it's in the HLS directory (just in case)
                    if self.hls_dir in file_path:
                        continue
                        
                    path = Path(file_path)
                    if path.suffix.lower() in VIDEO_EXTENSIONS:
                        self.queue.add(file_path)

        # 2. Start Observer
        for media_dir in self.media_dirs:
            event_handler = VideoHandler(self.queue, media_dir, self.hls_dir)
            self.observer.schedule(event_handler, media_dir, recursive=True)
        self.observer.start()
        logger.info("File watcher started")

        # 3. Start Worker Thread
        self.worker_thread = threading.Thread(target=self._process_queue, daemon=True)
        self.worker_thread.start()

    def stop(self):
        self.running = False
        self.observer.stop()
        self.observer.join()
        if self.worker_thread:
            self.worker_thread.join(timeout=5)

    def _process_queue(self):
        logger.info("Queue worker started")
        while self.running:
            item = self.queue.get_next()
            if item:
                try:
                    if isinstance(item, dict) and item.get("type") == "s3":
                        # S3 job from Kafka consumer
                        storage_key = item["storage_key"]
                        file_id     = item["file_id"]
                        import tempfile
                        temp_output_dir = tempfile.mkdtemp(prefix="hls_")
                        s3_key_prefix   = f"hls/{file_id}"
                        logger.info(f"Transcoding S3 file: {storage_key} -> {s3_key_prefix}")
                        transcode_to_hls(
                            input_path=storage_key,
                            output_dir=temp_output_dir,
                            s3_key_prefix=s3_key_prefix,
                        )
                        self.queue.mark_completed(item)
                    else:
                        # Local file path
                        file_path = item
                        logger.info(f"Processing from queue: {file_path}")
                        path_obj = Path(file_path)
                        try:
                            # Find which media dir contains this file
                            base_dir = None
                            for d in self.media_dirs:
                                try:
                                    path_obj.relative_to(Path(d))
                                    base_dir = d
                                    break
                                except ValueError:
                                    continue
                            
                            if base_dir is None:
                                logger.error(f"File {file_path} is not inside any media dir")
                                self.queue.mark_failed(file_path, "Outside media dirs")
                                continue

                            relative_path = path_obj.relative_to(Path(base_dir))
                            rel_str = str(relative_path).replace(os.sep, "/")
                            output_dir_name = rel_str.replace("/", "_").replace("\\", "_").replace(".", "_")
                            output_dir = os.path.join(base_dir, "hls", output_dir_name)
                            transcode_to_hls(file_path, output_dir)
                            self.queue.mark_completed(file_path)
                        except ValueError:
                            logger.error(f"File {file_path} is not inside media dir")
                            self.queue.mark_failed(file_path, "Outside media dir")
                except Exception as e:
                    logger.error(f"Error processing {item}: {e}")
                    self.queue.mark_failed(item, e)
            else:
                time.sleep(1)  # Wait for new items
