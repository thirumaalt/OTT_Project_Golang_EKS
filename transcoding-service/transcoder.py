"""
Video Transcoding Module for S3 and Local Storage

Handles transcoding videos to HLS format with multiple quality variants.
Supports both local filesystem and S3 input/output.
"""
import os
import sys
import subprocess
import logging
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from storage_manager import S3StorageManager

logger = logging.getLogger(__name__)

# Initialize storage manager
STORAGE_TYPE = os.getenv("STORAGE_TYPE", "local").lower()
S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME", "ott-media-raw")
storage = S3StorageManager(storage_type=STORAGE_TYPE, bucket_name=S3_BUCKET_NAME if STORAGE_TYPE == "s3" else None)


def check_nvidia_gpu() -> bool:
    """Check if NVIDIA GPU encoding is available."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True,
            text=True
        )
        return "h264_nvenc" in result.stdout
    except Exception as e:
        logger.warning(f"Could not check GPU: {e}")
        return False


def transcode_quality(input_file: str, output_dir: str, quality: Dict[str, str], use_gpu: bool) -> Dict[str, str]:
    """Transcode a single quality variant."""
    quality_dir = Path(output_dir) / quality['name']
    quality_dir.mkdir(parents=True, exist_ok=True)
    
    playlist = quality_dir / "playlist.m3u8"
    
    if use_gpu:
        video_codec = ["-c:v", "h264_nvenc"]
        preset = ["-preset", "p4"]
    else:
        video_codec = ["-c:v", "libx264"]
        preset = ["-preset", "veryfast"]
    
    cmd = [
        "ffmpeg",
        "-i", str(input_file),
        *video_codec,
        *preset,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-vf", f"scale=-2:{quality['height']}",
        "-b:v", quality['video_bitrate'],
        "-maxrate", quality['max_bitrate'],
        "-bufsize", quality['bufsize'],
        "-b:a", "128k",
        "-hls_time", "4",
        "-hls_list_size", "0",
        "-hls_segment_filename", str(quality_dir / "segment_%03d.ts"),
        "-movflags", "+faststart",
        "-threads", "0",
        "-f", "hls",
        str(playlist)
    ]
    
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    logger.info(f"Transcoded {quality['name']} quality")
    
    return quality


def create_master_playlist(output_dir: str, qualities: List[Dict[str, str]]) -> None:
    """Create master playlist with all quality variants."""
    output_path = Path(output_dir)
    master_playlist = output_path / "master.m3u8"
    
    with open(master_playlist, 'w') as f:
        f.write("#EXTM3U\n")
        f.write("#EXT-X-VERSION:3\n\n")
        
        for quality in qualities:
            bandwidth = int(quality['video_bitrate'].replace('k', '000'))
            f.write(f"#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},RESOLUTION={quality['width']}x{quality['height']}\n")
            f.write(f"{quality['name']}/playlist.m3u8\n\n")
    
    logger.info(f"Created master playlist: {master_playlist}")


def upload_hls_to_s3(local_output_dir: str, s3_key_prefix: str) -> None:
    """Upload transcoded HLS files to S3."""
    local_path = Path(local_output_dir)
    
    for file_path in local_path.rglob("*"):
        if file_path.is_file():
            relative_path = file_path.relative_to(local_path)
            s3_key = f"{s3_key_prefix}/{relative_path}".replace("\\", "/")
            
            logger.info(f"Uploading {s3_key} to S3...")
            storage.put_file_from_path(s3_key, str(file_path))
    
    logger.info(f"Uploaded all HLS files from {local_output_dir} to s3://{S3_BUCKET_NAME}/{s3_key_prefix}")


def transcode_to_hls(input_path: str, output_dir: str, s3_key_prefix: Optional[str] = None) -> None:
    """
    Transcodes a video file to HLS format with multiple quality variants.
    
    For S3 storage: Downloads from S3, transcodes locally, uploads back to S3.
    For local storage: Works directly on filesystem.
    
    Args:
        input_path: S3 key (if STORAGE_TYPE=s3) or local file path
        output_dir: Local temporary directory for transcoding
        s3_key_prefix: S3 prefix for output HLS files (required if STORAGE_TYPE=s3)
    """
    # For S3, we need to download the video first, transcode locally, then upload
    local_input_file = None
    cleanup_input = False
    
    try:
        if STORAGE_TYPE == "s3":
            if not s3_key_prefix:
                raise ValueError("s3_key_prefix required for S3 storage")
            
            # Download from S3 to temporary local file
            local_input_file = tempfile.NamedTemporaryFile(
                suffix=Path(input_path).suffix,
                delete=False
            ).name
            logger.info(f"Downloading {input_path} from S3...")
            storage.get_file(input_path, local_input_file)
            cleanup_input = True
        else:
            local_input_file = input_path
        
        # Check if HLS already exists
        master_playlist = Path(output_dir) / "master.m3u8"
        
        if STORAGE_TYPE == "s3":
            # Check if master.m3u8 exists in S3
            if storage.object_exists(f"{s3_key_prefix}/master.m3u8"):
                logger.info(f"HLS already exists for {s3_key_prefix}")
                return
        else:
            # Check if master.m3u8 exists locally
            if master_playlist.exists():
                logger.info(f"HLS already exists: {master_playlist}")
                return
        
        logger.info(f"Starting multi-quality transcoding for {input_path}")
        
        # Check for GPU support
        use_gpu = check_nvidia_gpu()
        
        if use_gpu:
            logger.info("Using NVIDIA GPU acceleration (NVENC)")
        else:
            logger.info("Using CPU encoding")
        
        # Create output directory
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        
        # Define quality variants
        qualities: List[Dict[str, str]] = [
            {
                'name': '1080p',
                'width': '1920',
                'height': '1080',
                'video_bitrate': '4500k',
                'max_bitrate': '5000k',
                'bufsize': '7500k'
            },
            {
                'name': '720p',
                'width': '1280',
                'height': '720',
                'video_bitrate': '2000k',
                'max_bitrate': '2500k',
                'bufsize': '3750k'
            },
            {
                'name': '480p',
                'width': '854',
                'height': '480',
                'video_bitrate': '800k',
                'max_bitrate': '1000k',
                'bufsize': '1500k'
            }
        ]
        
        # Transcode each quality
        transcoded_qualities: List[Dict[str, str]] = []
        for quality in qualities:
            try:
                transcode_quality(local_input_file, output_dir, quality, use_gpu)
                transcoded_qualities.append(quality)
            except subprocess.CalledProcessError as e:
                error_msg = e.stderr.decode() if e.stderr else str(e)
                logger.error(f"Failed to transcode {quality['name']}: {error_msg}")
                
                # Try CPU fallback for this quality
                if use_gpu and "nvenc" in error_msg.lower():
                    logger.warning(f"GPU encoding failed for {quality['name']}, trying CPU...")
                    try:
                        transcode_quality(local_input_file, output_dir, quality, False)
                        transcoded_qualities.append(quality)
                    except Exception as e2:
                        logger.error(f"CPU fallback also failed for {quality['name']}: {e2}")
                        # Continue with other qualities
                else:
                    logger.error(f"Skipping {quality['name']} quality")
        
        # Create master playlist with successfully transcoded qualities
        if transcoded_qualities:
            create_master_playlist(output_dir, transcoded_qualities)
            logger.info(f"Transcoding completed: {master_playlist}")
            
            # Upload to S3 if configured
            if STORAGE_TYPE == "s3":
                upload_hls_to_s3(output_dir, s3_key_prefix)
        else:
            raise Exception("All quality transcode attempts failed")
    
    except Exception as e:
        logger.error(f"Transcoding failed: {str(e)}")
        raise
    
    finally:
        # Clean up temporary input file
        if cleanup_input and local_input_file and Path(local_input_file).exists():
            try:
                Path(local_input_file).unlink()
                logger.info(f"Cleaned up temporary file: {local_input_file}")
            except Exception as e:
                logger.warning(f"Could not delete temporary file: {e}")

