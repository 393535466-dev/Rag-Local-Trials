# 本地模拟后端

这是给前端原型使用的零依赖 Python 模拟后端。它不调用百炼，也不把文件写入磁盘；上传记录和文件内容只保存在当前进程内存中，服务重启后会清空。后续接入真实百炼 RAG 时，可保留这些接口作为前端边界。

## 启动

在项目根目录执行：

```bash
python3 backend/server.py
# 或：python3 server.py
```

默认监听 `http://127.0.0.1:8000`，也可以指定地址和端口：

```bash
python3 server.py --host 0.0.0.0 --port 8000
```

## 接口

### 健康检查

```bash
curl http://127.0.0.1:8000/api/health
```

### 上传文件

推荐使用知识库级路径。一次请求可以包含一个或多个 `files[]` 字段（`file` 也兼容），返回 `documents` 数组。

```bash
curl -F 'files[]=@./样例.md' \
     -F 'files[]=@./样例.csv' \
     http://127.0.0.1:8000/api/knowledge-bases/demo-kb/uploads
```

返回 `201`（`documents` 是正式字段，`uploads`/`upload` 是兼容旧原型的别名）：

```json
{
  "documents": [
    {
      "id": "upl_…",
      "name": "样例.md",
      "size_bytes": 1234,
      "status": "queued",
      "chunks": 0,
      "created_at": "2026-10-26T…Z",
      "kind": "Markdown",
      "icon": "md",
      "task_id": "task_…"
    }
  ]
}
```

新记录最初为 `queued`，随后异步变为 `processing`，最后为 `completed` 或 `failed`。`status_label` 是给中文界面使用的辅助字段，`retrievable` 在完成后为 `true`。

旧版 `POST /api/uploads` 仍然可用，此时通过表单中的 `knowledge_base_id` 或 `kb_id` 指定知识库，未指定则使用 `default`。

### 查询解析状态

```bash
curl http://127.0.0.1:8000/api/uploads/upl_xxxxxxxxxxxxxxxx
```

`GET /api/uploads/{id}` 直接返回单个 document 对象（不是额外包一层 `upload`）。返回字段包括：

- `status`：`queued`、`processing`、`completed` 或 `failed`
- `progress`：0–100 的模拟进度
- `retrievable`：完成后为 `true`
- `chunks`：完成后的模拟知识片段数
- `error`：失败时的原因

### 知识库文档列表

```bash
curl http://127.0.0.1:8000/api/knowledge-bases/demo-kb/documents
```

返回：

```json
{
  "knowledge_base_id": "demo-kb",
  "total": 1,
  "documents": [/* 与 GET /api/uploads/{id} 相同的 document 对象 */]
}
```

### 本地模拟检索

已完成解析的文档会经过一条可观测的本地模拟 RAG 链路：确定性 Embedding → 向量召回 → 词法/语义模拟 Rerank。接口形状用于联调，不能代替真实模型：

```bash
curl -H 'Content-Type: application/json' \
     -d '{"query":"年假"}' \
     http://127.0.0.1:8000/api/knowledge-bases/demo-kb/search
```

返回 `{ "knowledge_base_id", "query", "hits": [...], "trace": {"stages": [...] } }`。每个 hit 含 `chunk_id`、`document_id`、`document`、`score`、`content` 和 `source`。

### 本地模拟对话

```bash
curl -H 'Content-Type: application/json' \
     -d '{"query":"年假可以跨年使用吗？","top_k":5}' \
     http://127.0.0.1:8000/api/knowledge-bases/demo-kb/chat
```

对话接口会执行：检索 → Rerank → 本地模拟 LLM，并返回 `answer`、`citations`、`usage`、`latency_ms`、`trace` 和 `log_id`。当没有足够依据时，回答会明确拒答，不会凭空补充。

### 运行日志

```bash
curl http://127.0.0.1:8000/api/logs
```

每条日志包含原始问题、知识库、模拟模型、输入/输出/总 Tokens、耗时、状态和引用。

### 查询知识库文档

```bash
curl http://127.0.0.1:8000/api/knowledge-bases/demo-kb/documents
```

返回 `knowledge_base_id`、`total` 和 `documents`。文档数组包含所有状态的上传记录，文件完成解析后会带有 `retrievable: true` 和大于等于 1 的 `chunks`。

首版接受 `PDF`、`DOCX`、`MD/Markdown`、`PNG/JPG/JPEG/WEBP`、`CSV` 和 `XLSX`。Markdown/CSV 会读取真实文本；DOCX/XLSX 使用标准 ZIP/XML 做基础提取；PDF、扫描 PDF 和图片走可替换的本地 OCR/解析占位适配器。每个文档会返回 `pipeline` 字段，展示 `ocr_parser → chunk → embedding → index` 的导入阶段。

当前实现仍是零依赖模拟版本：Embedding、Rerank、LLM 不调用外部模型，上传内容与日志只保存在内存中，服务重启后清空。后续可以在这些适配边界替换真实服务或 LangChain 编排，而不改变前端接口。
