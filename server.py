"""Small, dependency-free upload/parse backend for the local prototype.

This server intentionally keeps all state in memory.  It is useful while the
frontend is being wired to a real backend, but it is not intended for
production or for storing confidential documents.

Run with::

    python3 server.py

The API is documented in ``backend/README.md``.
"""

from __future__ import annotations

import argparse
import json
import math
import mimetypes
import threading
import time
import uuid
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import PurePath
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import unquote, urlparse


HOST = "127.0.0.1"
PORT = 8000
MAX_REQUEST_BYTES = 200 * 1024 * 1024

# These are the formats promised by the first prototype.  The parser below is
# deliberately a simulation; real extraction/OCR will be connected later.
SUPPORTED_EXTENSIONS = {
    ".pdf",
    ".docx",
    ".md",
    ".markdown",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".csv",
    ".xlsx",
}
TEXT_EXTENSIONS = {".md", ".markdown", ".csv", ".txt", ".json"}

UPLOADS: Dict[str, Dict[str, Any]] = {}
UPLOADS_BY_KB: Dict[str, List[str]] = {}
STATE_LOCK = threading.RLock()


def utc_now() -> str:
    """Return a compact ISO-8601 UTC timestamp."""

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def safe_filename(filename: str) -> str:
    """Strip path components from a browser supplied multipart filename."""

    # PurePath handles both slash styles, which is useful for files selected on
    # Windows and then uploaded to this macOS/Linux-friendly local server.
    cleaned = filename.replace("\\", "/")
    name = PurePath(cleaned).name.strip()
    return name or "untitled"


def extension_for(filename: str) -> str:
    name = safe_filename(filename).lower()
    dot = name.rfind(".")
    return name[dot:] if dot > 0 else ""


def human_kind(filename: str, content_type: str) -> str:
    ext = extension_for(filename)
    if ext == ".pdf":
        return "PDF 文档"
    if ext == ".docx":
        return "Word 文档"
    if ext in {".xlsx", ".csv"}:
        return "表格"
    if ext in {".md", ".markdown"}:
        return "Markdown"
    if ext in {".png", ".jpg", ".jpeg", ".webp"} or content_type.startswith("image/"):
        return "图片 · 云端 OCR"
    return content_type or "文件"


def document_icon(filename: str) -> str:
    """Return the icon key used by the existing React prototype."""

    ext = extension_for(filename)
    if ext == ".pdf":
        return "pdf"
    if ext == ".docx":
        return "word"
    if ext in {".xlsx", ".csv"}:
        return "sheet"
    if ext in {".md", ".markdown"}:
        return "md"
    return "image"


def status_label(status: str) -> str:
    return {
        "queued": "排队中",
        "processing": "解析中",
        "completed": "可检索",
        "failed": "失败",
    }.get(status, status)


def extract_text_chunks(filename: str, payload: bytes) -> Tuple[int, Optional[str]]:
    """Perform the smallest useful local extraction simulation.

    Markdown/CSV/JSON are decoded as UTF-8 when possible.  Binary document,
    spreadsheet, PDF and image files receive deterministic size/type based
    chunk counts, standing in for Baolian parsing, OCR, embedding and indexing.
    """

    ext = extension_for(filename)
    if ext in TEXT_EXTENSIONS:
        text = payload.decode("utf-8", errors="replace").strip()
        if text:
            # Keep paragraph/row boundaries where possible, then account for
            # long lines so the result behaves like a chunking stage.
            units = [line.strip() for line in text.replace("\r\n", "\n").split("\n") if line.strip()]
            chars = len(text)
            chunks = max(len(units), math.ceil(chars / 800)) if units else 1
            preview = text[:240]
            return chunks, preview
        return 1, None

    # Approximate how many chunks a real parser would produce.  A small file
    # always yields one chunk so that a successful upload is queryable.
    if ext in {".png", ".jpg", ".jpeg", ".webp"}:
        return 1, "图片内容将由云端 OCR 提取为文本。"
    if ext == ".pdf":
        return max(1, math.ceil(len(payload) / 80_000)), None
    if ext == ".docx":
        return max(1, math.ceil(len(payload) / 65_000)), None
    if ext == ".xlsx":
        return max(1, math.ceil(len(payload) / 35_000)), None
    return max(1, math.ceil(len(payload) / 80_000)), None


def public_upload(record: Dict[str, Any]) -> Dict[str, Any]:
    """Return API-safe metadata without the uploaded bytes."""

    # Keep the response deliberately stable and frontend-friendly.  Internal
    # bytes and text previews never leave the process through this function.
    return {
        "id": record["id"],
        "name": record["filename"],
        "filename": record["filename"],
        "knowledge_base_id": record["knowledge_base_id"],
        "size_bytes": record["size_bytes"],
        "status": record["status"],
        "status_label": status_label(record["status"]),
        "progress": record["progress"],
        "retrievable": record["retrievable"],
        "chunks": record["chunks"],
        "created_at": record["created_at"],
        "updated_at": record["updated_at"],
        "completed_at": record.get("completed_at"),
        "kind": record["kind"],
        "icon": record["icon"],
        "content_type": record["content_type"],
        "task_id": record["task_id"],
        "error": record.get("error"),
    }


def process_upload(upload_id: str) -> None:
    """Advance one upload asynchronously in memory."""

    # Short pauses make the asynchronous state observable in the UI and in
    # curl, without making local tests unnecessarily slow.
    with STATE_LOCK:
        record = UPLOADS.get(upload_id)
        if record is None:
            return
        record["status"] = "processing"
        record["progress"] = 15
        record["updated_at"] = utc_now()
    time.sleep(0.12)

    with STATE_LOCK:
        record = UPLOADS.get(upload_id)
        if record is None:
            return
        filename = record["filename"]
        payload = record["payload"]
        extension = extension_for(filename)
        if extension not in SUPPORTED_EXTENSIONS:
            record.update(
                status="failed",
                progress=100,
                retrievable=False,
                chunks=0,
                error=f"暂不支持 {extension or '该文件类型'}，首版支持 PDF、DOCX、MD、图片、CSV 和 XLSX",
                updated_at=utc_now(),
            )
            return
        record["progress"] = 55
        record["updated_at"] = utc_now()

    time.sleep(0.12)
    try:
        chunks, preview = extract_text_chunks(filename, payload)
    except Exception as exc:  # defensive: a malformed payload must not kill the worker
        with STATE_LOCK:
            record = UPLOADS.get(upload_id)
            if record is not None:
                record.update(
                    status="failed",
                    progress=100,
                    retrievable=False,
                    chunks=0,
                    error=f"解析失败：{exc}",
                    updated_at=utc_now(),
                )
        return

    with STATE_LOCK:
        record = UPLOADS.get(upload_id)
        if record is None:
            return
        record.update(
            status="completed",
            progress=100,
            retrievable=True,
            chunks=chunks,
            preview=preview,
            error=None,
            completed_at=utc_now(),
            updated_at=utc_now(),
        )


class Handler(BaseHTTPRequestHandler):
    server_version = "RagPrototype/0.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Keep the standard access log, but make it easy to distinguish from
        # application JSON when running the local server in a terminal.
        print(f"[{self.log_date_time_string()}] {format % args}")

    def _send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = HTTPStatus.BAD_REQUEST, **extra: Any) -> None:
        payload = {"error": message, **extra}
        self._send_json(payload, status)

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API name
        self._send_json({"ok": True})

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API name
        path = unquote(urlparse(self.path).path.rstrip("/")) or "/"
        if path == "/api/health":
            with STATE_LOCK:
                knowledge_bases = len(UPLOADS_BY_KB)
                uploads = len(UPLOADS)
            self._send_json(
                {
                    "status": "ok",
                    "service": "rag-simulation-backend",
                    "version": "0.1.0",
                    "uploads": uploads,
                    "knowledge_bases": knowledge_bases,
                }
            )
            return

        prefix = "/api/uploads/"
        if path.startswith(prefix) and path != prefix:
            upload_id = path[len(prefix) :].strip("/")
            with STATE_LOCK:
                record = UPLOADS.get(upload_id)
                payload = public_upload(record) if record else None
            if payload is None:
                self._error("上传记录不存在", HTTPStatus.NOT_FOUND)
            else:
                self._send_json(payload)
            return

        docs_prefix = "/api/knowledge-bases/"
        suffix = "/documents"
        if path.startswith(docs_prefix) and path.endswith(suffix):
            kb_id = path[len(docs_prefix) : -len(suffix)].strip("/")
            with STATE_LOCK:
                ids = list(UPLOADS_BY_KB.get(kb_id, []))
                documents = [public_upload(UPLOADS[item]) for item in ids if item in UPLOADS]
            self._send_json({"knowledge_base_id": kb_id, "total": len(documents), "documents": documents})
            return

        self._error("接口不存在", HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API name
        path = unquote(urlparse(self.path).path.rstrip("/")) or "/"
        kb_upload_prefix = "/api/knowledge-bases/"
        kb_upload_suffix = "/uploads"
        if path.startswith(kb_upload_prefix) and path.endswith(kb_upload_suffix):
            kb_id = path[len(kb_upload_prefix) : -len(kb_upload_suffix)].strip("/")
            if not kb_id:
                self._error("knowledge base id 不能为空")
                return
            self._handle_multipart_upload(kb_id)
            return
        if path == "/api/knowledge-bases" or path == "/api/knowledge-bases/":
            self._error("请在路径中提供 knowledge base id，例如 /api/knowledge-bases/demo-kb/uploads")
            return
        search_prefix = "/api/knowledge-bases/"
        search_suffix = "/search"
        if path.startswith(search_prefix) and path.endswith(search_suffix):
            kb_id = path[len(search_prefix) : -len(search_suffix)].strip("/")
            self._handle_search(kb_id)
            return
        if path != "/api/uploads":
            self._error("接口不存在", HTTPStatus.NOT_FOUND)
            return

        # Backward-compatible endpoint used by the initial backend draft.
        self._handle_multipart_upload(None)

    def _handle_search(self, kb_id: str) -> None:
        content_type = self.headers.get("Content-Type", "")
        if "application/json" not in content_type.lower():
            self._error("检索请求请使用 application/json", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            value = json.loads(body.decode("utf-8")) if body else {}
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._error(f"JSON 请求无效：{exc}")
            return
        query = str(value.get("query", "")).strip()
        if not query:
            self._error("query 不能为空")
            return
        terms = [term.lower() for term in query.split() if term.strip()]
        hits: List[Dict[str, Any]] = []
        with STATE_LOCK:
            ids = list(UPLOADS_BY_KB.get(kb_id, []))
            for item in ids:
                record = UPLOADS.get(item)
                if not record or record["status"] != "completed":
                    continue
                preview = (record.get("preview") or "").lower()
                filename = record["filename"].lower()
                score = sum(1 for term in terms if term in preview or term in filename)
                if score or not terms:
                    doc = public_upload(record)
                    hits.append(
                        {
                            "document_id": doc["id"],
                            "document": doc,
                            "score": round(min(0.99, 0.55 + 0.12 * score), 2),
                            "content": record.get("preview") or "模拟解析片段：该文档已完成解析，可接入百炼检索。",
                            "source": {"name": doc["name"], "page": None, "sheet": None},
                        }
                    )
        hits.sort(key=lambda hit: hit["score"], reverse=True)
        self._send_json({"knowledge_base_id": kb_id, "query": query, "hits": hits[:20]})

    def _handle_multipart_upload(self, forced_kb_id: Optional[str]) -> None:

        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data"):
            self._error("请使用 multipart/form-data 上传文件", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._error("Content-Length 无效", HTTPStatus.BAD_REQUEST)
            return
        if content_length <= 0:
            self._error("上传内容为空", HTTPStatus.BAD_REQUEST)
            return
        if content_length > MAX_REQUEST_BYTES:
            self._error(f"单次上传不能超过 {MAX_REQUEST_BYTES // (1024 * 1024)} MB", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        raw = self.rfile.read(content_length)
        envelope = b"Content-Type: " + content_type.encode("utf-8") + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw
        try:
            message = BytesParser(policy=policy.default).parsebytes(envelope)
        except Exception as exc:
            self._error(f"multipart 内容无法解析：{exc}")
            return

        fields: Dict[str, str] = {}
        files: List[Tuple[str, str, str, bytes]] = []
        for part in message.iter_parts():
            disposition = part.get_content_disposition()
            if disposition != "form-data":
                continue
            field_name = part.get_param("name", header="content-disposition") or ""
            filename = part.get_filename()
            if filename is not None:
                payload = part.get_payload(decode=True) or b""
                files.append((field_name, safe_filename(filename), part.get_content_type(), payload))
            else:
                value = part.get_content()
                fields[field_name] = value if isinstance(value, str) else str(value)
        if not files:
            self._error("multipart 中未找到文件字段", HTTPStatus.BAD_REQUEST)
            return

        kb_id = forced_kb_id or (fields.get("knowledge_base_id") or fields.get("kb_id") or "default").strip() or "default"
        created: List[Dict[str, Any]] = []
        for field_name, filename, file_type, payload in files:
            upload_id = "upl_" + uuid.uuid4().hex[:16]
            now = utc_now()
            record: Dict[str, Any] = {
                "id": upload_id,
                "knowledge_base_id": kb_id,
                "field": field_name,
                "filename": filename,
                "kind": human_kind(filename, file_type or mimetypes.guess_type(filename)[0] or ""),
                "icon": document_icon(filename),
                "content_type": file_type or mimetypes.guess_type(filename)[0] or "application/octet-stream",
                "size_bytes": len(payload),
                "task_id": "task_" + uuid.uuid4().hex[:16],
                "status": "queued",
                "progress": 0,
                "retrievable": False,
                "chunks": 0,
                "error": None,
                "created_at": now,
                "updated_at": now,
                "payload": payload,
                "preview": None,
            }
            with STATE_LOCK:
                UPLOADS[upload_id] = record
                UPLOADS_BY_KB.setdefault(kb_id, []).append(upload_id)
            worker = threading.Thread(target=process_upload, args=(upload_id,), daemon=True)
            worker.start()
            created.append(public_upload(record))

        # ``documents`` is the canonical contract used by the frontend.  The
        # legacy aliases are retained for callers of the first draft API.
        response: Dict[str, Any] = {"documents": created, "uploads": created}
        if len(created) == 1:
            response["document"] = created[0]
            response["upload"] = created[0]
        self._send_json(response, HTTPStatus.CREATED)


def run(host: str = HOST, port: int = PORT) -> None:
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"RAG prototype backend listening on http://{host}:{port}")
    print("Press Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Dependency-free local RAG upload simulation")
    parser.add_argument("--host", default=HOST, help=f"listen address (default: {HOST})")
    parser.add_argument("--port", type=int, default=PORT, help=f"listen port (default: {PORT})")
    args = parser.parse_args()
    run(args.host, args.port)


if __name__ == "__main__":
    main()
