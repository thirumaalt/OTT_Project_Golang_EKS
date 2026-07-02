"""
S3 Storage Manager for OTT Platform

Handles all S3 operations for media files, HLS segments, and metadata.
Supports both local filesystem (development) and S3 (production).
"""
import os
import logging
import io
from pathlib import Path
from typing import List, Optional, Iterator, Tuple
import boto3
from botocore.exceptions import ClientError, NoCredentialsError

logger = logging.getLogger(__name__)


class S3StorageManager:
    """Unified storage interface for S3 and local filesystem operations."""
    
    def __init__(self, storage_type: str = "local", bucket_name: Optional[str] = None):
        """
        Initialize storage manager.
        
        Args:
            storage_type: 'local' or 's3'
            bucket_name: S3 bucket name (required for S3 mode)
        """
        self.storage_type = storage_type.lower()
        self.bucket_name = bucket_name
        self.s3_client = None
        
        if self.storage_type == "s3":
            if not bucket_name:
                raise ValueError("bucket_name required for S3 storage")
            self._init_s3()
        
        logger.info(f"Initialized storage manager: {self.storage_type}")
    
    def _init_s3(self):
        """Initialize S3 client with AWS credentials."""
        try:
            self.s3_client = boto3.client(
                "s3",
                region_name=os.getenv("AWS_REGION", "ap-south-1"),
                aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
                aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
            )
            # Test connectivity
            self.s3_client.head_bucket(Bucket=self.bucket_name)
            logger.info(f"Connected to S3 bucket: {self.bucket_name}")
        except NoCredentialsError:
            logger.error("AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY")
            raise
        except ClientError as e:
            logger.error(f"Failed to connect to S3 bucket: {e}")
            raise
    
    def list_objects(self, prefix: str = "") -> List[str]:
        """
        List all objects in storage under a prefix.
        
        Args:
            prefix: S3 prefix or local directory path
            
        Returns:
            List of object keys/paths
        """
        if self.storage_type == "local":
            return self._list_local(prefix)
        else:
            return self._list_s3(prefix)
    
    def _list_local(self, path: str) -> List[str]:
        """List files in local directory recursively."""
        results = []
        base_path = Path(path)
        
        if not base_path.exists():
            return results
        
        for item in base_path.rglob("*"):
            if item.is_file():
                results.append(str(item.relative_to(base_path)))
        
        return results
    
    def _list_s3(self, prefix: str) -> List[str]:
        """List objects in S3 bucket."""
        results = []
        paginator = self.s3_client.get_paginator('list_objects_v2')
        
        try:
            for page in paginator.paginate(Bucket=self.bucket_name, Prefix=prefix):
                if 'Contents' in page:
                    for obj in page['Contents']:
                        results.append(obj['Key'])
        except ClientError as e:
            logger.error(f"Error listing S3 objects: {e}")
        
        return results
    
    def get_file(self, key: str, local_path: Optional[str] = None) -> bytes:
        """
        Download file from storage.
        
        Args:
            key: S3 key or local file path
            local_path: Optional local path to save file
            
        Returns:
            File bytes
        """
        if self.storage_type == "local":
            return self._get_local(key)
        else:
            return self._get_s3(key, local_path)
    
    def _get_local(self, path: str) -> bytes:
        """Read file from local filesystem."""
        try:
            with open(path, "rb") as f:
                return f.read()
        except FileNotFoundError:
            logger.error(f"File not found: {path}")
            raise
    
    def _get_s3(self, key: str, local_path: Optional[str] = None) -> bytes:
        """Download file from S3."""
        try:
            response = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)
            data = response['Body'].read()
            
            # Optionally save to local file
            if local_path:
                Path(local_path).parent.mkdir(parents=True, exist_ok=True)
                with open(local_path, "wb") as f:
                    f.write(data)
            
            return data
        except ClientError as e:
            logger.error(f"Error downloading from S3: {e}")
            raise
    
    def get_file_stream(self, key: str, chunk_size: int = 1024 * 64) -> Iterator[bytes]:
        """
        Stream file from storage in chunks.
        
        Args:
            key: S3 key or local file path
            chunk_size: Size of chunks to read
            
        Yields:
            File chunks as bytes
        """
        if self.storage_type == "local":
            yield from self._stream_local(key, chunk_size)
        else:
            yield from self._stream_s3(key, chunk_size)
    
    def _stream_local(self, path: str, chunk_size: int) -> Iterator[bytes]:
        """Stream file from local filesystem."""
        try:
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    yield chunk
        except FileNotFoundError:
            logger.error(f"File not found: {path}")
            raise
    
    def _stream_s3(self, key: str, chunk_size: int) -> Iterator[bytes]:
        """Stream file from S3."""
        try:
            response = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)
            for chunk in iter(lambda: response['Body'].read(chunk_size), b''):
                yield chunk
        except ClientError as e:
            logger.error(f"Error streaming from S3: {e}")
            raise
    
    def get_file_range(self, key: str, start: int, end: int, chunk_size: int = 1024 * 64) -> Iterator[bytes]:
        """
        Stream file range (for HTTP range requests).
        
        Args:
            key: S3 key or local file path
            start: Start byte position
            end: End byte position (inclusive)
            chunk_size: Size of chunks to read
            
        Yields:
            File chunks as bytes
        """
        if self.storage_type == "local":
            yield from self._stream_range_local(key, start, end, chunk_size)
        else:
            yield from self._stream_range_s3(key, start, end, chunk_size)
    
    def _stream_range_local(self, path: str, start: int, end: int, chunk_size: int) -> Iterator[bytes]:
        """Stream file range from local filesystem."""
        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    to_read = min(chunk_size, remaining)
                    chunk = f.read(to_read)
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk
        except FileNotFoundError:
            logger.error(f"File not found: {path}")
            raise
    
    def _stream_range_s3(self, key: str, start: int, end: int, chunk_size: int) -> Iterator[bytes]:
        """Stream file range from S3."""
        try:
            response = self.s3_client.get_object(
                Bucket=self.bucket_name,
                Key=key,
                Range=f"bytes={start}-{end}"
            )
            for chunk in iter(lambda: response['Body'].read(chunk_size), b''):
                yield chunk
        except ClientError as e:
            logger.error(f"Error streaming range from S3: {e}")
            raise
    
    def put_file(self, key: str, data: bytes, content_type: str = "application/octet-stream"):
        """
        Upload file to storage.
        
        Args:
            key: S3 key or local file path
            data: File data as bytes
            content_type: MIME type
        """
        if self.storage_type == "local":
            self._put_local(key, data)
        else:
            self._put_s3(key, data, content_type)
    
    def _put_local(self, path: str, data: bytes):
        """Write file to local filesystem."""
        local_path = Path(path)
        local_path.parent.mkdir(parents=True, exist_ok=True)
        with open(local_path, "wb") as f:
            f.write(data)
        logger.info(f"Wrote file: {path}")
    
    def _put_s3(self, key: str, data: bytes, content_type: str):
        """Upload file to S3."""
        try:
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=data,
                ContentType=content_type
            )
            logger.info(f"Uploaded to S3: s3://{self.bucket_name}/{key}")
        except ClientError as e:
            logger.error(f"Error uploading to S3: {e}")
            raise
    
    def put_file_from_path(self, key: str, local_path: str, content_type: str = "application/octet-stream"):
        """Upload file from local path to storage."""
        with open(local_path, "rb") as f:
            data = f.read()
        self.put_file(key, data, content_type)
    
    def delete_object(self, key: str):
        """Delete object from storage."""
        if self.storage_type == "local":
            self._delete_local(key)
        else:
            self._delete_s3(key)
    
    def _delete_local(self, path: str):
        """Delete file from local filesystem."""
        try:
            Path(path).unlink()
            logger.info(f"Deleted: {path}")
        except FileNotFoundError:
            logger.warning(f"File not found: {path}")
    
    def _delete_s3(self, key: str):
        """Delete object from S3."""
        try:
            self.s3_client.delete_object(Bucket=self.bucket_name, Key=key)
            logger.info(f"Deleted from S3: s3://{self.bucket_name}/{key}")
        except ClientError as e:
            logger.error(f"Error deleting from S3: {e}")
            raise
    
    def object_exists(self, key: str) -> bool:
        """Check if object exists in storage."""
        if self.storage_type == "local":
            return Path(key).exists()
        else:
            return self._s3_exists(key)
    
    def _s3_exists(self, key: str) -> bool:
        """Check if object exists in S3."""
        try:
            self.s3_client.head_object(Bucket=self.bucket_name, Key=key)
            return True
        except ClientError as e:
            if e.response['Error']['Code'] == '404':
                return False
            raise
    
    def get_object_size(self, key: str) -> int:
        """Get object size in bytes."""
        if self.storage_type == "local":
            return Path(key).stat().st_size
        else:
            return self._get_s3_size(key)
    
    def _get_s3_size(self, key: str) -> int:
        """Get S3 object size."""
        try:
            response = self.s3_client.head_object(Bucket=self.bucket_name, Key=key)
            return response['ContentLength']
        except ClientError as e:
            logger.error(f"Error getting object size: {e}")
            raise
    
    def get_signed_url(self, key: str, expiration: int = 3600) -> str:
        """
        Get signed URL for accessing object (S3 only).
        
        Args:
            key: S3 object key
            expiration: URL expiration time in seconds
            
        Returns:
            Signed URL
        """
        if self.storage_type == "local":
            return f"/media/{key}"  # Return local path
        
        try:
            url = self.s3_client.generate_presigned_url(
                'get_object',
                Params={'Bucket': self.bucket_name, 'Key': key},
                ExpiresIn=expiration
            )
            return url
        except ClientError as e:
            logger.error(f"Error generating signed URL: {e}")
            raise
