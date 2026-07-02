"""
Kafka consumer for the transcoding service.

Listens on the `video.uploaded` topic and feeds incoming events into the
existing TranscodeQueue so the file-watcher worker thread handles them —
the same worker that processes local file-system events.

For local storage:  event carries an absolute path; worker calls transcode_to_hls
For S3 storage:     event carries an S3 key;       worker calls transcode_to_hls
                    with s3_key_prefix derived from file_id
"""

import os
import json
import logging
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "kafka:9092")
KAFKA_TOPIC   = os.getenv("KAFKA_TOPIC",   "video.uploaded")
KAFKA_GROUP   = os.getenv("KAFKA_GROUP",   "transcoding-service")


def _handle_event(event: dict, queue, media_dir: str, hls_dir: str, storage_type: str):
    """
    Translate a video.uploaded event into a queue entry understood by
    file_watcher._process_queue().

    Queue entries for local storage are absolute file paths.
    For S3 we use a sentinel dict so the worker can detect S3 mode.
    """
    storage_key = event.get("storage_key")
    file_id     = event.get("file_id")

    if not storage_key or not file_id:
        logger.warning(f"Ignoring malformed event (missing storage_key/file_id): {event}")
        return

    if storage_type == "s3":
        # The file_watcher worker checks isinstance(entry, dict) to distinguish S3 items
        entry = {
            "type": "s3",
            "storage_key": storage_key,
            "file_id": file_id,
        }
        queue.add_s3(entry)
        logger.info(f"Queued S3 transcode job: s3://<bucket>/{storage_key}")
    else:
        # Local storage — construct absolute path and add to the normal queue
        abs_path = str(Path(media_dir) / storage_key)
        queue.add(abs_path)
        logger.info(f"Queued local transcode job: {abs_path}")


def start_kafka_consumer(queue, media_dir: str, hls_dir: str, storage_type: str):
    """
    Start the Kafka consumer in a background daemon thread.
    If Kafka is unavailable the thread retries with exponential back-off
    so the transcoding service still starts cleanly.
    """
    def _run():
        retry_delay = 5
        while True:
            try:
                from kafka import KafkaConsumer
                logger.info(f"Connecting to Kafka: brokers={KAFKA_BROKERS}, topic={KAFKA_TOPIC}")
                consumer = KafkaConsumer(
                    KAFKA_TOPIC,
                    bootstrap_servers=KAFKA_BROKERS.split(","),
                    group_id=KAFKA_GROUP,
                    value_deserializer=lambda m: json.loads(m.decode("utf-8")),
                    auto_offset_reset="earliest",   # pick up events missed while offline
                    enable_auto_commit=True,
                    session_timeout_ms=30_000,
                    heartbeat_interval_ms=10_000,
                )
                logger.info("Kafka consumer connected — listening for video.uploaded events")
                retry_delay = 5  # reset back-off on successful connect

                for message in consumer:
                    try:
                        event = message.value
                        logger.info(f"Received event from Kafka: {event}")
                        _handle_event(event, queue, media_dir, hls_dir, storage_type)
                    except Exception as e:
                        logger.error(f"Error handling Kafka message: {e}")

            except Exception as e:
                logger.error(f"Kafka consumer error: {e}. Retrying in {retry_delay}s...")
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 60)   # cap at 60s back-off

    thread = threading.Thread(target=_run, name="kafka-consumer", daemon=True)
    thread.start()
    logger.info("Kafka consumer thread started")
    return thread
