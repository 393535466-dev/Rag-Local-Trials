import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleHelp, Clock3, CloudUpload, File,
  FileImage, FileSpreadsheet, FileText, FolderOpen, Layers3, Menu, MessageCircle,
  MoreHorizontal, Plus, Search, Send, Settings2, ShieldCheck, SlidersHorizontal,
  Sparkles, TestTube2, X, Zap
} from 'lucide-react'

type Role = '管理员' | '知识库管理人员' | '使用者'
type Page = 'overview' | 'knowledge' | 'detail' | 'chat' | 'logs' | 'models'
type FileStatus = '可检索' | '解析中' | '失败'
type Doc = { id: number | string; name: string; kind: string; size: string; chunks: number; status: FileStatus; updated: string; icon: 'pdf' | 'word' | 'sheet' | 'image' | 'md'; taskId?: string }
type KB = { id: number; name: string; description: string; docs: number; chunks: number; updated: string; initials: string; color: string }
type Log = { id: number | string; query: string; kb: string; model: string; tokens: string; duration: string; time: string; status: '成功' | '失败' }
type SearchHit = { chunk_id?: string; document_id?: string | number; content: string; score: number; source?: { name?: string; page?: number | null; sheet?: string | null }; document?: Doc }
type Message = { role: 'user' | 'assistant'; text: string; source?: string; citations?: SearchHit[]; usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } }

const API_BASE = ((import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')

function statusLabel(value: unknown): FileStatus {
  const status = String(value || '').toLowerCase()
  if (['ready', 'completed', 'complete', '可检索'].includes(status)) return '可检索'
  if (['failed', 'error', '失败'].includes(status)) return '失败'
  return '解析中'
}

function documentIcon(name: string): Doc['icon'] {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'word'
  if (ext === 'xlsx' || ext === 'csv') return 'sheet'
  if (ext === 'md') return 'md'
  return 'image'
}

function normalizeDocument(raw: any): Doc {
  const name = String(raw?.name || raw?.filename || '未命名文件')
  const sizeBytes = Number(raw?.size_bytes ?? raw?.size ?? 0)
  return {
    id: raw?.id ?? raw?.document_id ?? raw?.task_id ?? `${Date.now()}-${name}`,
    taskId: raw?.task_id ? String(raw.task_id) : undefined,
    name,
    kind: String(raw?.kind || raw?.file_type || (documentIcon(name) === 'image' ? '图片 · 云端 OCR' : documentIcon(name) === 'sheet' ? '表格' : documentIcon(name) === 'word' ? 'Word 文档' : documentIcon(name) === 'pdf' ? 'PDF 文档' : 'Markdown')),
    size: raw?.size_label || (sizeBytes ? sizeBytes > 1024 * 1024 ? `${(sizeBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(sizeBytes / 1024))} KB` : '—'),
    chunks: Number(raw?.chunks ?? raw?.chunk_count ?? 0),
    status: statusLabel(raw?.status),
    updated: raw?.updated || raw?.updated_at || raw?.created_at || '刚刚',
    icon: raw?.icon || documentIcon(name),
  }
}

function normalizeLog(raw: any, knowledgeBases: KB[]): Log {
  const kbId = String(raw?.knowledge_base_id ?? '')
  const kb = knowledgeBases.find(item => String(item.id) === kbId)
  const totalTokens = raw?.total_tokens ?? raw?.tokens
  return {
    id: raw?.id ?? Date.now(),
    query: String(raw?.query ?? ''),
    kb: kb?.name ?? (kbId || '未知知识库'),
    model: String(raw?.model ?? 'local-simulated-llm'),
    tokens: totalTokens == null ? '未提供' : Number(totalTokens).toLocaleString('en-US'),
    duration: raw?.latency_ms == null ? '—' : `${(Number(raw.latency_ms) / 1000).toFixed(2)} s`,
    time: raw?.created_at ? new Date(raw.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '刚刚',
    status: raw?.status === 'success' || raw?.status === '成功' ? '成功' : '失败',
  }
}

const startingKbs: KB[] = [
  { id: 1, name: '人事制度与员工手册', description: '入职、考勤、假期、福利与员工行为规范', docs: 5, chunks: 241, updated: '今天 10:42', initials: '人', color: 'lavender' },
  { id: 2, name: '产品与服务手册', description: '产品功能说明、客户常见问题和操作指南', docs: 2, chunks: 98, updated: '昨天 16:28', initials: '产', color: 'peach' },
  { id: 3, name: '财务报销规范', description: '报销流程、费用标准与审批事项', docs: 2, chunks: 76, updated: '10 月 23 日', initials: '财', color: 'mint' },
]
const startingDocs: Doc[] = [
  { id: 1, name: '2026 员工手册.pdf', kind: 'PDF 文档', size: '4.8 MB', chunks: 112, status: '可检索', updated: '今天 10:42', icon: 'pdf' },
  { id: 2, name: '休假与考勤管理办法.docx', kind: 'Word 文档', size: '835 KB', chunks: 68, status: '可检索', updated: '昨天 15:20', icon: 'word' },
  { id: 3, name: '福利标准一览.xlsx', kind: 'Excel 表格', size: '126 KB', chunks: 42, status: '可检索', updated: '10 月 24 日', icon: 'sheet' },
  { id: 4, name: '入职办理流程图.png', kind: '图片 · 云端 OCR', size: '1.2 MB', chunks: 0, status: '解析中', updated: '刚刚', icon: 'image' },
  { id: 5, name: '岗位说明.md', kind: 'Markdown', size: '28 KB', chunks: 19, status: '可检索', updated: '10 月 22 日', icon: 'md' },
]
const productDocs: Doc[] = [
  { id: 21, name: '产品功能说明书.pdf', kind: 'PDF 文档', size: '2.3 MB', chunks: 62, status: '可检索', updated: '昨天 16:28', icon: 'pdf' },
  { id: 22, name: '客户常见问题.md', kind: 'Markdown', size: '44 KB', chunks: 36, status: '可检索', updated: '昨天 10:14', icon: 'md' },
]
const financeDocs: Doc[] = [
  { id: 31, name: '费用报销管理办法.docx', kind: 'Word 文档', size: '630 KB', chunks: 46, status: '可检索', updated: '10 月 23 日', icon: 'word' },
  { id: 32, name: '差旅费用标准.xlsx', kind: 'Excel 表格', size: '98 KB', chunks: 30, status: '可检索', updated: '10 月 21 日', icon: 'sheet' },
]
const startingLogs: Log[] = [
  { id: 1, query: '年假可以跨年使用吗？', kb: '人事制度与员工手册', model: 'qwen-plus', tokens: '1,284', duration: '2.4 s', time: '今天 11:08', status: '成功' },
  { id: 2, query: '出差住宿标准是多少？', kb: '财务报销规范', model: 'qwen-plus', tokens: '1,547', duration: '3.1 s', time: '今天 10:56', status: '成功' },
  { id: 3, query: '如何申请设备采购？', kb: '产品与服务手册', model: 'qwen-plus', tokens: '未提供', duration: '1.8 s', time: '昨天 17:32', status: '失败' },
]
const providers = [
  { name: 'OpenRouter', short: 'OR', tone: 'purple', endpoint: 'openrouter.ai/api/v1', models: 'LLM · Embedding · Rerank' },
  { name: 'AIHubMix', short: 'AI', tone: 'orange', endpoint: 'aihubmix.com/v1', models: 'LLM · Embedding · Rerank' },
  { name: '通义百炼', short: '千', tone: 'blue', endpoint: 'dashscope.aliyuncs.com', models: 'LLM · Embedding · Rerank · 文档解析' },
]

function Button({ children, onClick, variant = 'primary', icon, disabled = false, className = '' }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'text'; icon?: ReactNode; disabled?: boolean; className?: string }) {
  return <button className={`btn btn-${variant} ${className}`} onClick={onClick} disabled={disabled}>{icon}{children}</button>
}
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`badge badge-${tone}`}>{children}</span> }
function IconForDoc({ icon }: { icon: Doc['icon'] }) {
  const icons = { pdf: FileText, word: FileText, sheet: FileSpreadsheet, image: FileImage, md: File }
  const Comp = icons[icon]
  return <span className={`file-icon file-${icon}`}><Comp size={19} strokeWidth={1.9} /></span>
}

function App() {
  const [role, setRole] = useState<Role>('管理员')
  const [page, setPage] = useState<Page>('overview')
  const [kbs, setKbs] = useState(startingKbs)
  const [selectedKb, setSelectedKb] = useState(1)
  const [docsByKb, setDocsByKb] = useState<Record<number, Doc[]>>({ 1: startingDocs, 2: productDocs, 3: financeDocs })
  const [logs, setLogs] = useState(startingLogs)
  const [modal, setModal] = useState<'none' | 'create' | 'upload' | 'test' | 'provider' | 'doc'>('none')
  const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null)
  const [selectedProvider, setSelectedProvider] = useState('OpenRouter')
  const [providerConfigs, setProviderConfigs] = useState<Record<string, { llm: string; embedding: string; rerank: string; workspace: string }>>({})
  const [search, setSearch] = useState('')
  const [docSearch, setDocSearch] = useState('')
  const [logFilter, setLogFilter] = useState('全部')
  const [newKbName, setNewKbName] = useState('')
  const [newKbDescription, setNewKbDescription] = useState('')
  const [toast, setToast] = useState('')
  const [chatKb, setChatKb] = useState('人事制度与员工手册')
  const [chatQuestion, setChatQuestion] = useState('')
  const [conversation, setConversation] = useState<Message[]>([])
  const [testQuestion, setTestQuestion] = useState('年假可以跨年使用吗？')
  const [testResult, setTestResult] = useState(false)
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [logLoading, setLogLoading] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [llmModelId, setLlmModelId] = useState('')
  const [embeddingModelId, setEmbeddingModelId] = useState('')
  const [rerankModelId, setRerankModelId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [ocrEnabled, setOcrEnabled] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [backendOnline, setBackendOnline] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const currentKb = kbs.find(kb => kb.id === selectedKb) ?? kbs[0]
  const docs = docsByKb[selectedKb] ?? []
  const providerConfigured = Object.keys(providerConfigs)

  useEffect(() => {
    let cancelled = false
    fetch(`${API_BASE}/api/health`).then(response => { if (!cancelled) setBackendOnline(response.ok) }).catch(() => { if (!cancelled) setBackendOnline(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!backendOnline) return
    let cancelled = false
    fetch(`${API_BASE}/api/knowledge-bases/${selectedKb}/documents`).then(async response => {
      if (!response.ok) return
      const payload = await response.json()
      if (cancelled || !Array.isArray(payload?.documents)) return
      const nextDocs = payload.documents.map(normalizeDocument)
      setDocsByKb(previous => ({ ...previous, [selectedKb]: nextDocs }))
      setKbs(previous => previous.map(kb => kb.id === selectedKb ? { ...kb, docs: nextDocs.length, chunks: nextDocs.reduce((sum: number, doc: Doc) => sum + doc.chunks, 0), updated: nextDocs.length ? '刚刚' : kb.updated } : kb))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [backendOnline, selectedKb])

  useEffect(() => {
    if (!backendOnline) return
    const hasProcessing = docs.some(doc => doc.status === '解析中')
    if (!hasProcessing) return
    const timer = window.setInterval(() => {
      fetch(`${API_BASE}/api/knowledge-bases/${selectedKb}/documents`).then(async response => {
        if (!response.ok) return
        const payload = await response.json()
        if (Array.isArray(payload?.documents)) {
          const nextDocs = payload.documents.map(normalizeDocument)
          setDocsByKb(previous => ({ ...previous, [selectedKb]: nextDocs }))
          setKbs(previous => previous.map(kb => kb.id === selectedKb ? { ...kb, docs: nextDocs.length, chunks: nextDocs.reduce((sum: number, doc: Doc) => sum + doc.chunks, 0), updated: nextDocs.length ? '刚刚' : kb.updated } : kb))
        }
      }).catch(() => undefined)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [backendOnline, selectedKb, docs])

  useEffect(() => {
    if (!backendOnline || page !== 'logs') return
    let cancelled = false
    setLogLoading(true)
    fetch(`${API_BASE}/api/logs`).then(async response => {
      if (!response.ok) throw new Error('日志加载失败')
      const payload = await response.json()
      if (!cancelled && Array.isArray(payload?.logs)) setLogs(payload.logs.map((item: any) => normalizeLog(item, kbs)))
    }).catch(error => { if (!cancelled) showToast(error instanceof Error ? error.message : '日志加载失败') }).finally(() => { if (!cancelled) setLogLoading(false) })
    return () => { cancelled = true }
  }, [backendOnline, page, kbs])

  function showToast(message: string) { setToast(message); window.setTimeout(() => setToast(''), 3300) }
  function navigate(next: Page) { setPage(next); setSidebarOpen(false); setSearch('') }
  function selectRole(next: Role) { setRole(next); navigate(next === '使用者' ? 'chat' : 'overview') }
  function openProvider(name: string) { const saved = providerConfigs[name]; setSelectedProvider(name); setApiKey(''); setLlmModelId(saved?.llm ?? ''); setEmbeddingModelId(saved?.embedding ?? ''); setRerankModelId(saved?.rerank ?? ''); setWorkspaceId(saved?.workspace ?? ''); setModal('provider') }
  function createKb() {
    if (!newKbName.trim()) return
    const id = Date.now()
    setKbs([{ id, name: newKbName.trim(), description: newKbDescription.trim() || '尚未填写知识库描述', docs: 0, chunks: 0, updated: '刚刚', initials: newKbName.trim().slice(0, 1), color: 'lavender' }, ...kbs])
    setDocsByKb(previous => ({ ...previous, [id]: [] })); setSelectedKb(id); setNewKbName(''); setNewKbDescription(''); setModal('none'); setPage('detail'); showToast('知识库已创建，可以开始上传资料')
  }
  async function uploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    const allowed = ['pdf', 'docx', 'md', 'png', 'jpg', 'jpeg', 'csv', 'xlsx']
    const valid = files.filter(f => allowed.includes(f.name.split('.').pop()?.toLowerCase() || ''))
    if (!valid.length) {
      showToast('支持 PDF、DOCX、MD、图片、CSV 和 XLSX')
      event.target.value = ''
      return
    }
    if (backendOnline) {
      setUploading(true)
      const form = new FormData()
      valid.forEach(file => form.append('files', file))
      try {
        const response = await fetch(`${API_BASE}/api/knowledge-bases/${selectedKb}/uploads`, { method: 'POST', body: form })
        if (!response.ok) throw new Error(`上传失败 (${response.status})`)
        const payload = await response.json()
        const uploaded = Array.isArray(payload?.documents) ? payload.documents.map(normalizeDocument) : []
        setDocsByKb(previous => ({ ...previous, [selectedKb]: [...uploaded, ...(previous[selectedKb] ?? [])] }))
        setKbs(previous => previous.map(kb => kb.id === selectedKb ? { ...kb, docs: kb.docs + uploaded.length, updated: '刚刚' } : kb))
        setModal('none')
        showToast(`已上传 ${uploaded.length || valid.length} 个文件，正在模拟解析`)
      } catch (error) {
        showToast(error instanceof Error ? error.message : '上传失败，请检查本地后端')
      } finally {
        setUploading(false)
        event.target.value = ''
      }
      return
    }
    const added: Doc[] = valid.map((f, index) => {
      const ext = f.name.split('.').pop()?.toLowerCase()
      return { id: Date.now() + index, name: f.name, kind: ext === 'pdf' ? 'PDF 文档' : ext === 'docx' ? 'Word 文档' : ext === 'xlsx' || ext === 'csv' ? '表格' : ext === 'md' ? 'Markdown' : '图片 · 云端 OCR', size: f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`, chunks: 0, status: '解析中', updated: '刚刚', icon: ext === 'pdf' ? 'pdf' : ext === 'docx' ? 'word' : ext === 'xlsx' || ext === 'csv' ? 'sheet' : ext === 'md' ? 'md' : 'image' }
    })
    setDocsByKb(previous => ({ ...previous, [selectedKb]: [...added, ...(previous[selectedKb] ?? [])] }))
    if (added.length) setKbs(previous => previous.map(kb => kb.id === selectedKb ? { ...kb, docs: kb.docs + added.length, updated: '刚刚' } : kb))
    setModal('none'); event.target.value = ''
    showToast(`已添加 ${valid.length} 个演示文件；启动本地后端后将进入真实模拟解析流程`)
  }
  async function runSearch() {
    const query = testQuestion.trim()
    if (!query) return
    if (!backendOnline) { setSearchError('请先启动本地后端'); setTestResult(true); return }
    setSearchLoading(true); setSearchError(''); setSearchHits([]); setTestResult(true)
    try {
      const response = await fetch(`${API_BASE}/api/knowledge-bases/${selectedKb}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })
      if (!response.ok) throw new Error(`检索失败 (${response.status})`)
      const payload = await response.json()
      setSearchHits(Array.isArray(payload?.hits) ? payload.hits.map((hit: any) => ({ ...hit, document: hit.document ? normalizeDocument(hit.document) : undefined })) : [])
    } catch (error) { setSearchError(error instanceof Error ? error.message : '检索失败') } finally { setSearchLoading(false) }
  }

  async function sendMessage(question = chatQuestion) {
    const text = question.trim()
    if (!text || chatLoading) return
    const kb = kbs.find(item => item.name === chatKb)
    if (backendOnline && kb) {
      setChatLoading(true); setChatError('')
      setConversation(previous => [...previous, { role: 'user', text }])
      setChatQuestion('')
      try {
        const response = await fetch(`${API_BASE}/api/knowledge-bases/${kb.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: text, top_k: 5 }) })
        if (!response.ok) throw new Error(`对话失败 (${response.status})`)
        const result = await response.json()
        const citations = Array.isArray(result?.citations) ? result.citations.map((hit: any) => ({ ...hit, document: hit.document ? normalizeDocument(hit.document) : undefined })) : []
        setConversation(previous => [...previous, { role: 'assistant', text: String(result?.answer || '未生成回答'), citations, usage: result?.usage }])
      } catch (error) {
        const message = error instanceof Error ? error.message : '对话失败'
        setChatError(message)
        setConversation(previous => [...previous, { role: 'assistant', text: message }])
      } finally { setChatLoading(false) }
      return
    }
    const hasReadyDocs = (docsByKb[kb?.id ?? -1] ?? []).some(doc => doc.status === '可检索')
    const isLeaveExample = hasReadyDocs && kb?.id === 1 && text.includes('年假')
    const answer = !hasReadyDocs ? '这个知识库目前没有可检索的资料。请先导入文档，待解析完成后再提问。' : isLeaveExample ? '根据《2026 员工手册》和《休假与考勤管理办法》，当年度年假原则上应在本年度使用。确因工作安排无法休完时，可按公司审批流程申请结转，具体以制度原文和审批结果为准。' : '正式版本会先检索并重排原文片段，再基于引用内容生成回答。这条回复仅用于展示对话流程。'
    setConversation(previous => [...previous, { role: 'user', text }, { role: 'assistant', text: answer, source: isLeaveExample ? '2026 员工手册.pdf · 第 12 页' : undefined }])
    setLogs(previous => [{ id: Date.now(), query: text, kb: chatKb, model: '演示模型', tokens: '未提供', duration: '演示', time: '刚刚', status: '成功' }, ...previous])
    setChatQuestion('')
  }
  const navigation: { id: Page; label: string; icon: ReactNode; roles: Role[] }[] = [
    { id: 'overview', label: '工作台', icon: <Layers3 size={18} />, roles: ['管理员', '知识库管理人员'] },
    { id: 'knowledge', label: '知识库', icon: <BookOpen size={18} />, roles: ['管理员', '知识库管理人员'] },
    { id: 'chat', label: '在线对话', icon: <MessageCircle size={18} />, roles: ['管理员', '知识库管理人员', '使用者'] },
    { id: 'logs', label: '运行日志', icon: <Activity size={18} />, roles: ['管理员'] },
    { id: 'models', label: '模型配置', icon: <Settings2 size={18} />, roles: ['管理员'] },
  ]
  const filteredKbs = kbs.filter(kb => `${kb.name} ${kb.description}`.includes(search))
  const filteredDocs = docs.filter(doc => doc.name.includes(docSearch))
  const filteredLogs = logs.filter(log => logFilter === '全部' || log.status === logFilter)
  const pageTitle = page === 'overview' ? '工作台' : page === 'knowledge' ? '知识库' : page === 'detail' ? currentKb?.name : page === 'chat' ? '在线对话' : page === 'logs' ? '运行日志' : '模型配置'

  return <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="brand" onClick={() => navigate(role === '使用者' ? 'chat' : 'overview')}><div className="brand-mark"><Layers3 size={19} strokeWidth={2.4} /></div><div><strong>知序</strong><small>企业知识库中台</small></div></div>
      <div className="workspace-switch"><span className="workspace-avatar">企</span><span className="workspace-copy"><b>企业知识空间</b><small>内部试点工作区</small></span><ChevronDown size={15} /></div>
      <div className="nav-section-label">工作空间</div>
      <nav className="nav-list">{navigation.filter(item => item.roles.includes(role)).map(item => <button key={item.id} className={`nav-item ${page === item.id || (page === 'detail' && item.id === 'knowledge') ? 'active' : ''}`} onClick={() => navigate(item.id)}>{item.icon}<span>{item.label}</span>{item.id === 'knowledge' && <span className="nav-count">{kbs.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="help-box"><span className="help-icon"><Sparkles size={17} /></span><b>让知识更好用</b><p>从资料入库到对话引用，完成一条可追溯的知识链路。</p><button onClick={() => navigate(role === '使用者' ? 'chat' : 'knowledge')}>{role === '使用者' ? '开始对话' : '查看知识库'} <ArrowRight size={13} /></button></div><div className="sidebar-foot"><CircleHelp size={16} /> {backendOnline ? '本地模拟后端 · SQLite 数据' : '前端演示 · 启动后端可联调'}</div></div>
    </aside>

    <div className="main-area">
      <header className="topbar"><div className="topbar-left"><button className="mobile-menu icon-btn" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={21} /></button><span className="breadcrumb">企业知识空间</span><ChevronRight size={14} className="muted" /><strong>{pageTitle}</strong></div><div className="topbar-actions"><div className="prototype-pill"><span style={{ background: backendOnline ? '#4eb899' : undefined }}></span> {backendOnline ? '本地模拟后端已连接' : '前端演示模式'}</div><div className="role-picker"><span className="role-avatar">{role.slice(0, 1)}</span><select aria-label="选择演示角色" value={role} onChange={event => selectRole(event.target.value as Role)}><option>管理员</option><option>知识库管理人员</option><option>使用者</option></select><ChevronDown size={14} /></div></div></header>

      <main className={`content content-${page}`}>
        {page === 'overview' && <>
          <div className="welcome"><div><div className="eyebrow"><Sparkles size={15} /> 知识有序，回答有据</div><h1>上午好，欢迎回到知序</h1><p>从资料导入到知识问答，在这里掌握每一步的进展。</p><div className="welcome-actions"><Button onClick={() => setModal('create')} icon={<Plus size={17} />}>创建知识库</Button><Button variant="secondary" onClick={() => navigate('chat')} icon={<MessageCircle size={17} />}>开始对话</Button></div></div><div className="welcome-art"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="art-center"><Layers3 size={33} /></div><div className="art-chip chip-a"><FileText size={16} /> 资料</div><div className="art-chip chip-b"><Sparkles size={16} /> 知识</div><div className="art-chip chip-c"><MessageCircle size={16} /> 回答</div></div></div>
          <div className="section-heading"><div><h2>空间概览</h2><p>持续更新的知识资产与使用情况</p></div><span className="subtle">示例数据</span></div>
          <div className="stats-grid"><StatCard icon={<BookOpen size={20}/>} value={String(kbs.length)} label="知识库" note="已创建" tone="purple" /><StatCard icon={<FileText size={20}/>} value={String(Object.values(docsByKb).reduce((sum, items) => sum + items.length, 0))} label="知识文档" note="跨全部知识库" tone="blue" /><StatCard icon={<MessageCircle size={20}/>} value={String(logs.length + 125)} label="累计对话" note="最近 30 天" tone="orange" /><StatCard icon={<Zap size={20}/>} value="98.2%" label="查询成功率" note="最近 30 天" tone="green" /></div>
          <div className="overview-columns"><section className="panel"><div className="panel-heading"><div><h2>最近的知识库</h2><p>继续管理或检查知识内容</p></div><button className="link-button" onClick={() => navigate('knowledge')}>查看全部 <ArrowRight size={15}/></button></div><div className="recent-list">{kbs.slice(0, 3).map(kb => <button className="recent-kb" key={kb.id} onClick={() => { setSelectedKb(kb.id); navigate('detail') }}><span className={`kb-avatar ${kb.color}`}>{kb.initials}</span><span><strong>{kb.name}</strong><small>{kb.docs} 份文档 · {kb.updated}更新</small></span><ChevronRight size={17}/></button>)}</div></section><section className="panel flow-panel"><div className="panel-heading"><div><h2>三步开始使用</h2><p>构建可引用的企业知识问答</p></div></div><div className="flow-step"><span>01</span><div><b>配置模型</b><p>连接大模型、向量模型与重排模型</p></div><CheckCircle2 size={17}/></div><div className="flow-step"><span>02</span><div><b>导入资料</b><p>上传文档，检查解析与分块结果</p></div><ArrowRight size={16}/></div><div className="flow-step"><span>03</span><div><b>对话验证</b><p>提问并核对回答引用的原文</p></div><ArrowRight size={16}/></div></section></div>
        </>}

        {page === 'knowledge' && <><PageIntro eyebrow="KNOWLEDGE BASE" title="知识库" description="集中管理企业资料，让每一次回答都有来源可查。" action={<Button onClick={() => setModal('create')} icon={<Plus size={17}/>}>创建知识库</Button>} /><div className="toolbar"><div className="search-field"><Search size={17}/><input placeholder="搜索知识库名称或描述" value={search} onChange={event => setSearch(event.target.value)}/></div><div className="toolbar-right"><Badge tone="purple">共 {filteredKbs.length} 个知识库</Badge></div></div><div className="kb-grid">{filteredKbs.map(kb => <button key={kb.id} className="kb-card" onClick={() => { setSelectedKb(kb.id); navigate('detail') }}><div className="kb-card-top"><span className={`kb-avatar large ${kb.color}`}>{kb.initials}</span><MoreHorizontal size={19}/></div><h3>{kb.name}</h3><p>{kb.description}</p><div className="kb-card-footer"><span><FileText size={15}/>{kb.docs} 份文档</span><span><Layers3 size={15}/>{kb.chunks} 个片段</span></div><div className="kb-card-date">更新于 {kb.updated}<ArrowRight size={16}/></div></button>)}<button className="kb-add" onClick={() => setModal('create')}><span><Plus size={23}/></span><b>创建新知识库</b><small>开始沉淀一个新的知识主题</small></button></div></>}

        {page === 'detail' && <><button className="back-link" onClick={() => navigate('knowledge')}><ArrowLeft size={16}/> 返回知识库</button><div className="detail-header"><div className={`kb-avatar large ${currentKb.color}`}>{currentKb.initials}</div><div><div className="detail-title-row"><h1>{currentKb.name}</h1><Badge tone={docs.some(doc => doc.status === '可检索') ? 'green' : 'blue'}><span className="status-dot"/> {docs.some(doc => doc.status === '可检索') ? '可检索' : '待导入资料'}</Badge></div><p>{currentKb.description}</p></div><Button onClick={() => setModal('upload')} icon={<CloudUpload size={17}/>}>上传资料</Button></div><div className="detail-metrics"><div><span>文档总数</span><strong>{docs.length}</strong></div><div><span>可检索文档</span><strong>{docs.filter(doc => doc.status === '可检索').length}</strong></div><div><span>知识片段</span><strong>{docs.reduce((sum, doc) => sum + doc.chunks, 0)}</strong></div><div><span>向量模型</span><strong className="metric-model">text-embedding-v4</strong></div></div><div className="detail-tabs"><button className="active">文档内容</button><button onClick={() => { setTestResult(false); setModal('test') }}>检索测试</button><button onClick={() => showToast('知识库设置将在正式版本中连接后端')}>知识库设置</button></div><div className="panel document-panel"><div className="panel-heading"><div><h2>文档内容</h2><p>上传后可查看解析状态、知识片段与来源信息</p></div><Button variant="secondary" onClick={() => { setTestResult(false); setModal('test') }} icon={<TestTube2 size={16}/>}>检索测试</Button></div><div className="toolbar doc-toolbar"><div className="search-field"><Search size={17}/><input placeholder="搜索文档名称" value={docSearch} onChange={event => setDocSearch(event.target.value)}/></div><button className="filter-button" onClick={() => showToast('当前显示全部文档')}><SlidersHorizontal size={16}/> 全部状态 <ChevronDown size={14}/></button></div><div className="table-scroll"><table className="data-table"><thead><tr><th>文档名称</th><th>状态</th><th>知识片段</th><th>更新时间</th><th></th></tr></thead><tbody>{filteredDocs.map(doc => <tr key={doc.id} onClick={() => { setSelectedDoc(doc); setModal('doc') }}><td><div className="table-file"><IconForDoc icon={doc.icon}/><div><strong>{doc.name}</strong><small>{doc.kind} · {doc.size}</small></div></div></td><td><Badge tone={doc.status === '可检索' ? 'green' : doc.status === '解析中' ? 'blue' : 'red'}><span className="status-dot"/>{doc.status}</Badge></td><td>{doc.chunks || '—'}</td><td>{doc.updated}</td><td><MoreHorizontal size={17}/></td></tr>)}</tbody></table></div>{filteredDocs.length === 0 && <div className="empty-state"><FolderOpen size={35}/><b>这里还没有文档</b><p>上传资料后即可查看解析进度和检索状态。</p><Button onClick={() => setModal('upload')} icon={<Plus size={16}/>}>上传资料</Button></div>}</div></>}

        {page === 'chat' && <div className="chat-layout"><aside className="chat-history"><div className="chat-history-top"><strong>对话记录</strong><button className="icon-btn" title="新建对话" onClick={() => setConversation([])}><Plus size={18}/></button></div><button className="new-chat" onClick={() => setConversation([])}><Plus size={17}/> 新建对话</button><span className="history-label">最近对话</span><button className="history-item active" onClick={() => { setConversation([{role:'user',text:'年假可以跨年使用吗？'},{role:'assistant',text:'根据《2026 员工手册》，年假原则上应在当年度使用。特殊情况可提交申请，由相关负责人审批。',source:'2026 员工手册.pdf · 第 12 页'}]); setChatKb('人事制度与员工手册') }}><MessageCircle size={15}/> 年假可以跨年使用吗？</button><button className="history-item" onClick={() => { setConversation([{role:'user',text:'出差住宿标准是多少？'},{role:'assistant',text:'请查阅《财务报销规范》中对应城市和职级的住宿标准。'}]); setChatKb('财务报销规范') }}><MessageCircle size={15}/> 出差住宿标准是多少？</button><div className="history-footer"><Clock3 size={15}/> 历史会话仅为演示数据</div></aside><section className="chat-main"><div className="chat-top"><div><h1>知识问答</h1><p>基于企业资料回答，支持查看引用来源</p></div><div className="chat-kb-picker"><BookOpen size={16}/><select aria-label="选择对话知识库" value={chatKb} onChange={event => setChatKb(event.target.value)}>{kbs.map(kb => <option key={kb.id}>{kb.name}</option>)}</select><ChevronDown size={14}/></div></div><div className="conversation">{conversation.length === 0 ? <div className="chat-empty"><div className="chat-spark"><Sparkles size={31}/></div><h2>你好，有什么想了解的？</h2><p>我会从选定的知识库里查找资料，并标出回答依据。</p><div className="suggestions"><button onClick={() => sendMessage('年假可以跨年使用吗？')}>年假可以跨年使用吗？ <ArrowRight size={15}/></button><button onClick={() => sendMessage('新员工如何办理入职？')}>新员工如何办理入职？ <ArrowRight size={15}/></button><button onClick={() => sendMessage('出差报销需要哪些材料？')}>出差报销需要哪些材料？ <ArrowRight size={15}/></button></div></div> : <div className="messages">{conversation.map((message, index) => <div className={`message message-${message.role}`} key={index}>{message.role === 'assistant' && <div className="assistant-avatar"><Sparkles size={17}/></div>}<div className="message-body">{message.role === 'assistant' && <b>知序助手</b>}<div className="message-bubble">{message.text}</div>{(message.source || message.citations?.length) && <>{message.source && <div className="citation"><FileText size={15}/> 引用来源：{message.source}</div>}{message.citations?.slice(0, 3).map((citation, citationIndex) => <button className="citation" key={citationIndex} onClick={() => { const doc = citation.document || docs.find(item => String(item.id) === String(citation.document_id)); if (doc) { setSelectedDoc(doc); setModal('doc') } }}><FileText size={15}/> 引用来源：{citation.source?.name || citation.document?.name || '知识片段'}{citation.source?.page ? ` · 第 ${citation.source.page} 页` : ''} <ChevronRight size={14}/></button>)}</>}</div></div>)}</div>}</div><div className="composer-wrap"><div className="composer"><textarea rows={2} placeholder="向知识库提问，例如：年假可以跨年使用吗？" value={chatQuestion} onChange={event => setChatQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage() } }}/><div className="composer-bottom"><span><ShieldCheck size={15}/> {chatLoading ? '正在检索并生成回答…' : chatError || '回答将附带资料引用'}</span><button className="send-button" onClick={() => sendMessage()} disabled={!chatQuestion.trim() || chatLoading} aria-label="发送问题"><Send size={18}/></button></div></div><small>{backendOnline ? '已连接本地 RAG 模拟后端' : '原型演示模式，请先启动后端'}</small></div></section></div>}

        {page === 'logs' && <><PageIntro eyebrow="ACTIVITY LOG" title="运行日志" description="查看每次提问、模型消耗和响应表现，定位回答问题。" action={<Button variant="secondary" onClick={() => showToast('正式版本支持导出筛选后的日志')} icon={<ArrowDownToLine size={16}/>}>导出日志</Button>} /><div className="stats-grid log-stats"><StatCard icon={<MessageCircle size={20}/>} value={String(logs.length)} label="总查询量" note={logLoading ? '正在刷新' : '本地后端记录'} tone="purple"/><StatCard icon={<Zap size={20}/>} value={`${logs.length ? Math.round(logs.filter(log => log.status === '成功').length / logs.length * 1000) / 10 : 0}%`} label="成功率" note="当前日志" tone="green"/><StatCard icon={<Clock3 size={20}/>} value={logs.length ? `${(logs.reduce((sum, log) => sum + (Number.parseFloat(log.duration) || 0), 0) / logs.length).toFixed(2)} s` : '—'} label="平均耗时" note="查询至回答完成" tone="blue"/><StatCard icon={<Activity size={20}/>} value={logs.reduce((sum, log) => sum + (Number(log.tokens.replace(/,/g, '')) || 0), 0).toLocaleString('en-US')} label="累计 Tokens" note="后端返回统计" tone="orange"/></div><section className="panel log-panel"><div className="panel-heading"><div><h2>对话查询记录</h2><p>显示用户问题、所用模型与每次请求的运行结果</p></div><Badge tone="neutral">{logLoading ? '加载中…' : `共 ${logs.length} 条`}</Badge></div><div className="toolbar"><div className="search-field"><Search size={17}/><input placeholder="搜索查询内容" value={search} onChange={event => setSearch(event.target.value)}/></div><div className="segmented">{['全部','成功','失败'].map(value => <button key={value} className={logFilter === value ? 'active' : ''} onClick={() => setLogFilter(value)}>{value}</button>)}</div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>查询内容</th><th>知识库 / 模型</th><th>Tokens</th><th>耗时</th><th>状态</th><th>时间</th></tr></thead><tbody>{filteredLogs.filter(log => log.query.includes(search)).map(log => <tr key={log.id}><td className="query-cell">{log.query}</td><td><span className="two-lines">{log.kb}<small>{log.model}</small></span></td><td>{log.tokens}</td><td>{log.duration}</td><td><Badge tone={log.status === '成功' ? 'green' : 'red'}><span className="status-dot"/>{log.status}</Badge></td><td>{log.time}</td></tr>)}</tbody></table></div></section></>}

        {page === 'models' && <><PageIntro eyebrow="MODEL SETTINGS" title="模型配置" description="连接服务商，分别指定对话、向量和重排模型。正式版本由服务端保存密钥。" /><div className="notice"><ShieldCheck size={19}/><span><b>先完成模型连接，再开始导入资料</b><br/>知识库至少需要一个 Embedding 模型；在线回答还需要 LLM。Rerank 用于提升候选片段排序质量。</span></div><div className="section-heading"><div><h2>模型服务商</h2><p>第一版支持以下三个服务商，模型 ID 由你填写</p></div></div><div className="provider-grid">{providers.map(provider => <div className="provider-card" key={provider.name}><div className="provider-head"><span className={`provider-logo ${provider.tone}`}>{provider.short}</span><Badge tone={providerConfigured.includes(provider.name) ? 'green' : 'neutral'}>{providerConfigured.includes(provider.name) ? '已配置 · 演示' : '未配置'}</Badge></div><h3>{provider.name}</h3><p>{provider.endpoint}</p><div className="provider-models">{providerConfigs[provider.name] ? ['LLM', 'Embedding', 'Rerank'].filter((_, index) => [providerConfigs[provider.name].llm, providerConfigs[provider.name].embedding, providerConfigs[provider.name].rerank][index]).join(' · ') || '文档解析' : provider.models}</div><Button variant="secondary" onClick={() => openProvider(provider.name)} icon={<Settings2 size={16}/>}>{providerConfigured.includes(provider.name) ? '编辑配置' : '配置服务商'}</Button></div>)}</div><div className="section-heading model-heading"><div><h2>模型用途</h2><p>三个类型可以来自不同服务商；实际可用模型由服务商决定</p></div></div><div className="model-types"><div><span className="model-type-icon purple"><MessageCircle size={21}/></span><h3>对话模型 LLM</h3><p>理解问题并依据引用资料生成回答</p><Badge tone="purple">用于在线对话</Badge></div><div><span className="model-type-icon blue"><Layers3 size={21}/></span><h3>向量模型 Embedding</h3><p>为资料和问题建立语义检索表示</p><Badge tone="blue">用于导入与检索</Badge></div><div><span className="model-type-icon orange"><SlidersHorizontal size={21}/></span><h3>重排模型 Rerank</h3><p>对召回片段再次排序，提升相关性</p><Badge tone="orange">用于检索优化</Badge></div></div><div className="ocr-row"><div className="ocr-icon"><FileImage size={22}/></div><div><h3>百炼云端文档解析</h3><p>用于扫描 PDF、图片及文档内图片的文字识别。正式版本需配置独立解析服务参数。</p></div><button className={`toggle ${ocrEnabled ? 'on' : ''}`} aria-label="启用百炼云端解析" onClick={() => setOcrEnabled(!ocrEnabled)}><span/></button></div></>}
      </main>
    </div>

    {toast && <div className="toast"><CheckCircle2 size={17}/>{toast}</div>}
    {modal !== 'none' && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setModal('none') }}><div className={`modal ${modal === 'doc' ? 'modal-wide' : ''}`} role="dialog" aria-modal="true"><div className="modal-head"><div><h2>{modal === 'create' ? '创建知识库' : modal === 'upload' ? '上传资料' : modal === 'test' ? '检索测试' : modal === 'provider' ? `配置 ${selectedProvider}` : selectedDoc?.name}</h2><p>{modal === 'create' ? '为一组相关资料建立独立知识空间' : modal === 'upload' ? '上传后可检查解析状态和知识片段' : modal === 'test' ? '验证问题能否命中正确的知识片段' : modal === 'provider' ? '配置模型用途与连接信息' : '查看文档解析和引用预览'}</p></div><button className="icon-btn" onClick={() => setModal('none')} aria-label="关闭"><X size={20}/></button></div>
      {modal === 'create' && <div className="modal-body"><label>知识库名称 <em>*</em><input autoFocus placeholder="例如：客户服务手册" value={newKbName} onChange={event => setNewKbName(event.target.value)}/></label><label>描述 <span>选填</span><textarea rows={3} placeholder="简要说明知识库包含哪些资料" value={newKbDescription} onChange={event => setNewKbDescription(event.target.value)}/></label><div className="modal-info"><Layers3 size={18}/> 默认使用当前 Embedding 模型；正式版本支持在知识库设置中调整。</div><div className="modal-actions"><Button variant="secondary" onClick={() => setModal('none')}>取消</Button><Button onClick={createKb} disabled={!newKbName.trim()}>创建知识库</Button></div></div>}
      {modal === 'upload' && <div className="modal-body"><input ref={fileRef} type="file" multiple accept=".pdf,.docx,.md,.png,.jpg,.jpeg,.csv,.xlsx" hidden onChange={uploadFiles}/><button className="upload-drop" onClick={() => fileRef.current?.click()} disabled={uploading}><span><CloudUpload size={27}/></span><b>{uploading ? '正在上传…' : '点击选择文件'}</b><small>支持批量选择 PDF、DOCX、MD、PNG/JPG、CSV、XLSX</small></button><div className="upload-tips"><div><Check size={15}/> {backendOnline ? '本地模拟解析：自动生成知识片段' : '启动本地后端后执行模拟解析'}</div><div><Check size={15}/> 表格保留表头与行信息</div><div><Check size={15}/> 失败后可查看原因并重试</div></div><div className="modal-info">{backendOnline ? '当前已连接本地模拟后端，上传后会经历“解析中 → 可检索”状态。' : '当前为前端演示模式。启动 backend/server.py 后，文件才会真正上传并自动完成模拟解析。'}</div><div className="modal-actions"><Button variant="secondary" onClick={() => setModal('none')}>取消</Button><Button onClick={() => fileRef.current?.click()} disabled={uploading} icon={<Plus size={16}/>}>{uploading ? '处理中…' : '选择文件'}</Button></div></div>}
      {modal === 'test' && <div className="modal-body"><label>测试问题<textarea rows={3} value={testQuestion} onChange={event => { setTestQuestion(event.target.value); setTestResult(false); setSearchError(''); setSearchHits([]) }} placeholder="输入你希望从知识库查找的问题"/></label><div className="test-options"><span>知识库：{currentKb.name}</span><span>召回片段：20 → 重排后：5</span></div>{testResult && <div className="test-result">{searchLoading ? <div className="no-result"><Clock3 size={20}/> 正在执行 Embedding、召回和 Rerank…</div> : searchError ? <div className="no-result"><FolderOpen size={20}/> {searchError}</div> : searchHits.length ? <><div className="result-title"><CheckCircle2 size={17}/> 命中 {searchHits.length} 个知识片段 <Badge tone="neutral">真实检索结果</Badge></div>{searchHits.slice(0, 5).map((hit, index) => <div className="result-item" key={hit.chunk_id || `${hit.document_id}-${index}`}><strong>{hit.source?.name || hit.document?.name || '知识片段'}{hit.source?.page ? ` · 第 ${hit.source.page} 页` : hit.source?.sheet ? ` · ${hit.source.sheet}` : ''}</strong><p>{hit.content}</p><span>相关度 {(Number(hit.score || 0) * 100).toFixed(1)}%</span></div>)}</> : <div className="no-result"><FolderOpen size={20}/> 当前问题没有命中足够依据。</div>}</div>}<div className="modal-actions"><Button variant="secondary" onClick={() => setModal('none')}>关闭</Button><Button onClick={runSearch} disabled={!testQuestion.trim() || searchLoading} icon={<Search size={16}/>}>{searchLoading ? '检索中…' : '开始测试'}</Button></div></div>}
      {modal === 'provider' && <div className="modal-body"><div className="provider-modal-logo"><span className={`provider-logo ${providers.find(p => p.name === selectedProvider)?.tone}`}>{providers.find(p => p.name === selectedProvider)?.short}</span><div><b>{selectedProvider}</b><small>请使用示例值体验原型，勿填写真实密钥</small></div></div><label>API Key <em>*</em><input type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="例如 sk-demo-xxxx"/></label><div className="model-id-fields"><label>对话模型 LLM <span>选填</span><input value={llmModelId} onChange={event => setLlmModelId(event.target.value)} placeholder="例如 qwen-plus"/></label><label>向量模型 Embedding <span>选填</span><input value={embeddingModelId} onChange={event => setEmbeddingModelId(event.target.value)} placeholder="例如 text-embedding-v4"/></label><label>重排模型 Rerank <span>选填</span><input value={rerankModelId} onChange={event => setRerankModelId(event.target.value)} placeholder="例如 qwen3-rerank"/></label></div>{selectedProvider === '通义百炼' && <label>文档解析 Workspace ID <span>启用 OCR 时填写</span><input value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} placeholder="例如 ws-xxxxxxxx"/></label>}<div className="modal-info"><ShieldCheck size={17}/> 三种模型可分别填写，也可跨服务商组合。正式版本将在服务端加密存储密钥，并提供逐项连通性测试。</div><div className="modal-actions"><Button variant="secondary" onClick={() => setModal('none')}>取消</Button><Button onClick={() => { setProviderConfigs(previous => ({ ...previous, [selectedProvider]: { llm: llmModelId, embedding: embeddingModelId, rerank: rerankModelId, workspace: workspaceId } })); setModal('none'); showToast(`${selectedProvider} 配置已在原型中标记，尚未真实连接`) }} disabled={!apiKey || !(llmModelId || embeddingModelId || rerankModelId || (selectedProvider === '通义百炼' && workspaceId))} icon={<Check size={16}/>}>保存演示配置</Button></div></div>}
      {modal === 'doc' && selectedDoc && <div className="modal-body doc-preview"><div className="doc-preview-meta"><IconForDoc icon={selectedDoc.icon}/><div><b>{selectedDoc.kind}</b><span>{selectedDoc.size} · 更新于 {selectedDoc.updated}</span></div><Badge tone={selectedDoc.status === '可检索' ? 'green' : 'blue'}>{selectedDoc.status}</Badge></div>{selectedDoc.status === '解析中' ? <div className="preview-processing"><Clock3 size={24}/><b>资料正在解析</b><p>完成 OCR、分块和向量化后，这里会显示原文与知识片段。</p></div> : <div className="preview-columns"><div><div className="preview-title">解析内容预览 <Badge tone="neutral">示例</Badge></div><article><h3>{selectedDoc.name.includes('员工') || selectedDoc.name.includes('休假') ? '第一章 休假与考勤' : selectedDoc.name.includes('产品') || selectedDoc.name.includes('客户') ? '产品功能与常见问题' : '费用标准与管理办法'}</h3><p>{selectedDoc.name.includes('员工') || selectedDoc.name.includes('休假') ? '公司实行统一的考勤管理制度。员工请假应提前在系统中提交申请，由部门负责人审批。' : selectedDoc.name.includes('产品') || selectedDoc.name.includes('客户') ? '本资料整理产品功能、适用场景与常见操作步骤，供员工查阅。' : '费用报销应按标准提交申请，审批通过后办理结算。'}</p><h4>{selectedDoc.icon === 'sheet' ? '表格数据' : '关键内容'}</h4><p>{selectedDoc.name.includes('员工') || selectedDoc.name.includes('休假') ? '年假原则上应在当年度安排使用。确因工作安排无法休完时，可按公司审批流程申请结转。' : selectedDoc.name.includes('产品') || selectedDoc.name.includes('客户') ? '使用者可依据功能说明和常见问题定位所需的操作方法。' : '差旅标准按出行城市及职级执行，具体以原始制度和审批结果为准。'}</p><div className="preview-table"><div>项目</div><div>说明</div><div>{selectedDoc.icon === 'sheet' ? '表格行' : '文档段落'}</div><div>保留来源信息</div></div></article></div><div><div className="preview-title">知识片段 <Badge tone="purple">{selectedDoc.chunks || 0} 条</Badge></div><div className="chunk-preview"><span>片段 01 · {selectedDoc.icon === 'sheet' ? '工作表 1' : '第 12 页'}</span><p>{selectedDoc.name.includes('员工') || selectedDoc.name.includes('休假') ? '年假原则上应在当年度安排使用。确因工作安排无法休完时，可按公司审批流程申请结转。' : selectedDoc.name.includes('产品') || selectedDoc.name.includes('客户') ? '产品功能说明与客户常见问题可拆分为可检索的知识片段。' : '差旅费用标准和审批要求可按表格行检索。'}</p></div><div className="chunk-preview"><span>片段 02 · {selectedDoc.icon === 'sheet' ? '工作表 1' : '第 13 页'}</span><p>每个片段保留原始文档名称、页码或工作表位置，便于核对回答来源。</p></div></div></div>}<div className="modal-info">预览是示例内容。正式版本将展示实际解析结果、表格和页码。</div><div className="modal-actions"><Button variant="secondary" onClick={() => setModal('none')}>关闭</Button>{role !== '使用者' && <Button onClick={() => { setModal('none'); setTestResult(false); setModal('test') }} icon={<TestTube2 size={16}/>}>检索测试</Button>}</div></div>}
    </div></div>}
  </div>
}

function StatCard({ icon, value, label, note, tone }: { icon: ReactNode; value: string; label: string; note: string; tone: string }) { return <div className="stat-card"><span className={`stat-icon ${tone}`}>{icon}</span><div><strong>{value}</strong><b>{label}</b><small>{note}</small></div></div> }
function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) { return <div className="page-intro"><div><span className="page-eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div> }

export default App
