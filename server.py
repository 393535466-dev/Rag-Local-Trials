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
import hashlib
import json
import math
import mimetypes
import re
import sqlite3
import threading
import time
import uuid
import zipfile
from io import BytesIO
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import PurePath
from pathlib import Path
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
CHUNKS: Dict[str, Dict[str, Any]] = {}
LOGS: List[Dict[str, Any]] = []
STATE_LOCK = threading.RLock()

DATA_DIR = Path(__file__).resolve().parent / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "rag.sqlite3"
STORAGE_READY = False


def db_connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(DB_PATH), timeout=30)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_storage() -> None:
    """Create the local durable store and hydrate the in-memory index."""
    global STORAGE_READY
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with db_connect() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                knowledge_base_id TEXT NOT NULL,
                field TEXT,
                filename TEXT NOT NULL,
                kind TEXT NOT NULL,
                icon TEXT NOT NULL,
                content_type TEXT,
                size_bytes INTEGER NOT NULL,
                task_id TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL DEFAULT 0,
                retrievable INTEGER NOT NULL DEFAULT 0,
                chunks INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT,
                error TEXT,
                file_path TEXT NOT NULL,
                preview TEXT,
                pipeline_json TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(knowledge_base_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                text TEXT NOT NULL,
                embedding_json TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                source_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_kb ON chunks(knowledge_base_id);
            CREATE TABLE IF NOT EXISTS logs (
                id TEXT PRIMARY KEY,
                query TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                latency_ms REAL NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                citations_json TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
            """
        )
    load_storage_state()
    STORAGE_READY = True
    # A process can stop between the queued/processing stages. Resume those
    # tasks on the next start instead of leaving them permanently stuck.
    with STATE_LOCK:
        pending_ids = [
            item["id"] for item in UPLOADS.values()
            if item.get("status") in {"queued", "processing"} and item.get("payload")
        ]
    for upload_id in pending_ids:
        threading.Thread(target=process_upload, args=(upload_id,), daemon=True).start()


def load_storage_state() -> None:
    """Hydrate the process cache after startup so existing data is usable."""
    with STATE_LOCK, db_connect() as connection:
        UPLOADS.clear()
        UPLOADS_BY_KB.clear()
        CHUNKS.clear()
        LOGS.clear()
        for row in connection.execute("SELECT * FROM documents ORDER BY created_at DESC"):
            file_path = Path(row["file_path"])
            payload = file_path.read_bytes() if file_path.exists() else b""
            record = {
                "id": row["id"], "knowledge_base_id": row["knowledge_base_id"], "field": row["field"],
                "filename": row["filename"], "kind": row["kind"], "icon": row["icon"],
                "content_type": row["content_type"] or "application/octet-stream", "size_bytes": row["size_bytes"],
                "task_id": row["task_id"], "status": row["status"], "progress": row["progress"],
                "retrievable": bool(row["retrievable"]), "chunks": row["chunks"], "created_at": row["created_at"],
                "updated_at": row["updated_at"], "completed_at": row["completed_at"], "error": row["error"],
                "file_path": str(file_path), "payload": payload, "preview": row["preview"],
                "pipeline": json.loads(row["pipeline_json"] or "[]"),
            }
            UPLOADS[record["id"]] = record
            UPLOADS_BY_KB.setdefault(record["knowledge_base_id"], []).append(record["id"])
        for row in connection.execute("SELECT * FROM chunks"):
            CHUNKS[row["id"]] = {
                "id": row["id"], "document_id": row["document_id"], "knowledge_base_id": row["knowledge_base_id"],
                "text": row["text"], "embedding": json.loads(row["embedding_json"]), "index": row["chunk_index"],
                "source": json.loads(row["source_json"]),
            }
        for row in connection.execute("SELECT * FROM logs ORDER BY created_at DESC"):
            LOGS.append({
                "id": row["id"], "query": row["query"], "knowledge_base_id": row["knowledge_base_id"],
                "model": row["model"], "input_tokens": row["input_tokens"], "output_tokens": row["output_tokens"],
                "total_tokens": row["total_tokens"], "latency_ms": row["latency_ms"], "status": row["status"],
                "created_at": row["created_at"], "citations": json.loads(row["citations_json"] or "[]"),
            })


def persist_document(record: Dict[str, Any]) -> None:
    with db_connect() as connection:
        connection.execute(
            """INSERT OR REPLACE INTO documents
            (id,knowledge_base_id,field,filename,kind,icon,content_type,size_bytes,task_id,status,progress,retrievable,chunks,created_at,updated_at,completed_at,error,file_path,preview,pipeline_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (record["id"], record["knowledge_base_id"], record.get("field"), record["filename"], record["kind"], record["icon"], record.get("content_type"), record["size_bytes"], record["task_id"], record["status"], record["progress"], int(record["retrievable"]), record["chunks"], record["created_at"], record["updated_at"], record.get("completed_at"), record.get("error"), record["file_path"], record.get("preview"), json.dumps(record.get("pipeline", []), ensure_ascii=False)),
        )


def persist_chunks_for_document(document_id: str) -> None:
    with db_connect() as connection:
        connection.execute("DELETE FROM chunks WHERE document_id = ?", (document_id,))
        for chunk in CHUNKS.values():
            if chunk.get("document_id") != document_id:
                continue
            connection.execute(
                "INSERT OR REPLACE INTO chunks (id,document_id,knowledge_base_id,text,embedding_json,chunk_index,source_json) VALUES (?,?,?,?,?,?,?)",
                (chunk["id"], chunk["document_id"], chunk["knowledge_base_id"], chunk["text"], json.dumps(chunk["embedding"]), chunk["index"], json.dumps(chunk["source"], ensure_ascii=False)),
            )


def persist_log(log: Dict[str, Any]) -> None:
    with db_connect() as connection:
        connection.execute(
            "INSERT OR REPLACE INTO logs (id,query,knowledge_base_id,model,input_tokens,output_tokens,total_tokens,latency_ms,status,created_at,citations_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (log["id"], log["query"], log["knowledge_base_id"], log["model"], log["input_tokens"], log["output_tokens"], log["total_tokens"], log["latency_ms"], log["status"], log["created_at"], json.dumps(log.get("citations", []), ensure_ascii=False)),
        )


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


def extract_document_text(filename: str, payload: bytes) -> Tuple[str, Dict[str, Any]]:
    """Extract a useful local text representation without third-party packages.

    This is intentionally an adapter boundary: production can replace it with
    OCR/vision and layout parsers while keeping the RAG pipeline unchanged.
    """
    ext = extension_for(filename)
    if ext in TEXT_EXTENSIONS:
        return payload.decode("utf-8", errors="replace").strip(), {"source_type": "text"}
    if ext == ".docx":
        try:
            with zipfile.ZipFile(BytesIO(payload)) as archive:
                xml = archive.read("word/document.xml").decode("utf-8", errors="replace")
            text = re.sub(r"</w:p>", "\n", xml)
            text = re.sub(r"<w:tab[^>]*/>", "\t", text)
            text = re.sub(r"<[^>]+>", "", text)
            return re.sub(r"\n{3,}", "\n\n", text).strip(), {"source_type": "docx"}
        except Exception:
            return "Word 文档已上传，模拟解析器未能读取其 XML 内容。", {"source_type": "docx"}
    if ext == ".xlsx":
        try:
            with zipfile.ZipFile(BytesIO(payload)) as archive:
                shared = []
                if "xl/sharedStrings.xml" in archive.namelist():
                    raw = archive.read("xl/sharedStrings.xml").decode("utf-8", errors="replace")
                    shared = re.findall(r"<t[^>]*>(.*?)</t>", raw)
                sheets = [name for name in archive.namelist() if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")]
                rows: List[str] = []
                for sheet in sorted(sheets):
                    raw = archive.read(sheet).decode("utf-8", errors="replace")
                    for row in re.findall(r"<row[^>]*>(.*?)</row>", raw, flags=re.S):
                        values = []
                        for cell_type, value in re.findall(r"<c[^>]*?(?:t=\"([^\"]+)\")?[^>]*>.*?<v>(.*?)</v>.*?</c>", row, flags=re.S):
                            value = re.sub(r"<[^>]+>", "", value)
                            if cell_type == "s" and value.isdigit() and int(value) < len(shared):
                                value = shared[int(value)]
                            values.append(value)
                        if values:
                            rows.append(" | ".join(values))
                return "\n".join(rows).strip(), {"source_type": "xlsx"}
        except Exception:
            return "表格已上传，模拟解析器未能读取其工作表内容。", {"source_type": "xlsx"}
    if ext == ".pdf":
        # Basic extraction for text PDFs; scanned PDFs use the OCR placeholder.
        decoded = payload.decode("latin-1", errors="ignore")
        strings = re.findall(r"\(([^()]*)\)", decoded)
        text = "\n".join(item for item in strings if len(item.strip()) > 2)
        return text.strip() or "扫描 PDF 已接收，模拟 OCR 已将页面标记为可检索内容。", {"source_type": "pdf", "page": 1}
    if ext in {".png", ".jpg", ".jpeg", ".webp"}:
        return "图片已接收，模拟 OCR 文本：请在此替换为云端 OCR 返回的识别结果。", {"source_type": "ocr", "page": 1}
    return "文件已接收并完成模拟解析。", {"source_type": "generic"}


def chunk_text(text: str, max_chars: int = 500, overlap: int = 60) -> List[str]:
    clean = re.sub(r"\n{3,}", "\n\n", text or "").strip()
    if not clean:
        return ["文档没有可提取的文字内容。"]
    chunks: List[str] = []
    start = 0
    while start < len(clean):
        end = min(len(clean), start + max_chars)
        if end < len(clean):
            boundary = max(clean.rfind("\n", start, end), clean.rfind("。", start, end), clean.rfind(" ", start, end))
            if boundary > start + max_chars // 2:
                end = boundary + 1
        chunks.append(clean[start:end].strip())
        if end >= len(clean):
            break
        start = max(start + 1, end - overlap)
    return chunks


def tokenize(text: str) -> List[str]:
    return [item.lower() for item in re.findall(r"[\u4e00-\u9fff]|[a-zA-Z0-9_]+", text or "")]


def embedding(text: str, dimensions: int = 64) -> List[float]:
    vector = [0.0] * dimensions
    for token in tokenize(text):
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % dimensions
        vector[index] += 1.0 if digest[4] % 2 else -1.0
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def cosine(left: List[float], right: List[float]) -> float:
    return sum(a * b for a, b in zip(left, right))


def build_chunks(record: Dict[str, Any], text: str, metadata: Dict[str, Any]) -> None:
    pieces = chunk_text(text)
    for index, piece in enumerate(pieces):
        chunk_id = f"chk_{uuid.uuid4().hex[:16]}"
        CHUNKS[chunk_id] = {
            "id": chunk_id,
            "document_id": record["id"],
            "knowledge_base_id": record["knowledge_base_id"],
            "text": piece,
            "embedding": embedding(piece),
            "index": index,
            "source": {"name": record["filename"], "page": metadata.get("page", index + 1), "sheet": metadata.get("sheet")},
        }
    record["chunks"] = len(pieces)
    record["preview"] = text[:240] if text else None


def extract_text_chunks(filename: str, payload: bytes) -> Tuple[int, Optional[str]]:
    """Perform the smallest useful local extraction simulation.

    Markdown/CSV/JSON are decoded as UTF-8 when possible.  Binary document,
    spreadsheet, PDF and image files receive deterministic size/type based
    chunk counts, standing in for Baolian parsing, OCR, embedding and indexing.
    """

    text, _ = extract_document_text(filename, payload)
    return len(chunk_text(text)), text[:240] if text else None


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
        "pipeline": record.get("pipeline", []),
    }


def retrieve(kb_id: str, query: str, limit: int = 5) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Run the local analogue of embedding retrieval + reranking."""
    started = time.perf_counter()
    query_vector = embedding(query)
    terms = set(tokenize(query))
    candidates: List[Dict[str, Any]] = []
    with STATE_LOCK:
        for chunk in CHUNKS.values():
            if chunk.get("knowledge_base_id") != kb_id:
                continue
            lexical = sum(1 for term in terms if term in set(tokenize(chunk.get("text", ""))))
            vector_score = max(0.0, cosine(query_vector, chunk.get("embedding", [])))
            candidates.append({**chunk, "vector_score": vector_score, "lexical_score": lexical})
    candidates.sort(key=lambda item: (item["vector_score"], item["lexical_score"]), reverse=True)
    recalled = candidates[: min(20, len(candidates))]
    # Rerank favors exact lexical matches, then semantic similarity.
    for item in recalled:
        item["rerank_score"] = min(0.99, 0.35 * item["vector_score"] + 0.65 * min(1.0, item["lexical_score"] / max(1, len(terms))))
    recalled.sort(key=lambda item: item["rerank_score"], reverse=True)
    # A local simulator should still model the most important RAG guardrail:
    # low-confidence context must not be passed to the answer stage. Exact
    # lexical overlap is accepted; otherwise require a modest semantic score.
    recalled = [item for item in recalled if item["lexical_score"] > 0 or item["vector_score"] >= 0.2]
    hits = []
    for item in recalled[:limit]:
        doc = UPLOADS.get(item["document_id"])
        if not doc:
            continue
        hits.append({
            "chunk_id": item["id"],
            "document_id": doc["id"],
            "document": public_upload(doc),
            "score": round(item["rerank_score"], 4),
            "content": item["text"],
            "source": item["source"],
        })
    trace = {
        "stages": [
            {"name": "embedding", "provider": "local-simulated-embedding", "dimensions": 64},
            {"name": "retrieval", "candidates": len(candidates), "recalled": len(recalled)},
            {"name": "rerank", "model": "local-simulated-rerank", "returned": len(hits)},
        ],
        "latency_ms": round((time.perf_counter() - started) * 1000, 2),
    }
    return hits, trace


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
        persist_document(record)
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
            persist_document(record)
            return
        record["progress"] = 55
        record["updated_at"] = utc_now()
        persist_document(record)

    time.sleep(0.12)
    try:
        text, metadata = extract_document_text(filename, payload)
        chunks = chunk_text(text)
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
                persist_document(record)
        return

    with STATE_LOCK:
        record = UPLOADS.get(upload_id)
        if record is None:
            return
        # Simulate the full ingestion stages while keeping the adapter local:
        # OCR/parser -> chunk -> embedding -> index.  Each chunk stores its
        # vector so retrieval can use the same interface as a real provider.
        for old_id, old_chunk in list(CHUNKS.items()):
            if old_chunk.get("document_id") == upload_id:
                del CHUNKS[old_id]
        build_chunks(record, text, metadata)
        record.update(
            status="completed",
            progress=100,
            retrievable=True,
            chunks=len(chunks),
            preview=text[:240] if text else None,
            error=None,
            completed_at=utc_now(),
            updated_at=utc_now(),
            pipeline=[
                {"name": "ocr_parser", "status": "completed", "mode": metadata.get("source_type", "local-simulation")},
                {"name": "chunk", "status": "completed", "count": len(chunks), "max_chars": 500, "overlap": 60},
                {"name": "embedding", "status": "completed", "provider": "local-simulated-embedding", "dimensions": 64},
                {"name": "index", "status": "completed", "collection": record["knowledge_base_id"]},
            ],
        )
        persist_document(record)
        persist_chunks_for_document(upload_id)


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
                    "chunks": len(CHUNKS),
                    "logs": len(LOGS),
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

        if path == "/api/logs":
            with STATE_LOCK:
                logs = list(LOGS)
            self._send_json({"total": len(logs), "logs": logs})
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
        chat_suffix = "/chat"
        if path.startswith(search_prefix) and path.endswith(chat_suffix):
            kb_id = path[len(search_prefix) : -len(chat_suffix)].strip("/")
            self._handle_chat(kb_id)
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
        hits, trace = retrieve(kb_id, query, limit=20)
        self._send_json({"knowledge_base_id": kb_id, "query": query, "hits": hits, "trace": trace})

    def _read_json_body(self) -> Optional[Dict[str, Any]]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            value = json.loads(body.decode("utf-8")) if body else {}
            return value if isinstance(value, dict) else None
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _handle_chat(self, kb_id: str) -> None:
        if "application/json" not in self.headers.get("Content-Type", "").lower():
            self._error("对话请求请使用 application/json", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return
        value = self._read_json_body()
        if value is None:
            self._error("JSON 请求无效")
            return
        query = str(value.get("query", "")).strip()
        if not query:
            self._error("query 不能为空")
            return
        started = time.perf_counter()
        hits, retrieval_trace = retrieve(kb_id, query, limit=int(value.get("top_k", 5) or 5))
        if hits:
            answer = "根据知识库资料，" + "；".join(hit["content"][:180] for hit in hits[:3])
            answer += "。"
        else:
            answer = "当前知识库没有找到足够的依据，请补充资料或换一种问法。"
        input_tokens = max(1, len(tokenize(query)) + sum(len(tokenize(hit["content"])) for hit in hits[:3]))
        output_tokens = max(1, len(tokenize(answer)))
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        trace = {
            "stages": retrieval_trace["stages"] + [{"name": "llm", "model": "local-simulated-llm", "streaming": False}],
            "latency_ms": latency_ms,
        }
        log = {
            "id": "log_" + uuid.uuid4().hex[:16],
            "query": query,
            "knowledge_base_id": kb_id,
            "model": "local-simulated-llm",
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
            "latency_ms": latency_ms,
            "status": "success",
            "created_at": utc_now(),
            "citations": [hit["source"] for hit in hits],
        }
        with STATE_LOCK:
            LOGS.insert(0, log)
            persist_log(log)
        self._send_json({
            "knowledge_base_id": kb_id,
            "query": query,
            "answer": answer,
            "citations": hits,
            "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens, "total_tokens": input_tokens + output_tokens},
            "latency_ms": latency_ms,
            "trace": trace,
            "log_id": log["id"],
        })

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
                "pipeline": [],
            }
            file_path = UPLOAD_DIR / f"{upload_id}{extension_for(filename)}"
            file_path.write_bytes(payload)
            record["file_path"] = str(file_path)
            with STATE_LOCK:
                UPLOADS[upload_id] = record
                UPLOADS_BY_KB.setdefault(kb_id, []).append(upload_id)
                persist_document(record)
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
    initialize_storage()
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
