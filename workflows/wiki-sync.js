
export const meta = {
  name: 'wiki-sync',
  description: '确定性探测 raw/sources 中尚未 ingest 的源文件，自动调用 wiki-ingest 增量摄入',
  whenToUse: '向 raw/sources/ 添加了新素材后，或定期巡检时使用；用 find+grep 精确对比文件系统，不依赖 LLM 读 log.md',
  phases: [
    { title: '探测', detail: '用 find 列出 raw/sources 全量文件，grep 提取 wiki 中 sources: 字段，JS 层做集合差' },
    { title: '摄入', detail: '调用 wiki-ingest 子工作流处理新文件' },
  ],
}

const WIKI_ROOT = args?.root ?? (await agent('运行 pwd 并只返回绝对路径，不要多余文字', {
  label: 'detect-root', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
})).path

// args.force=true 时强制重新 ingest 已有源文件（用于文件内容变更后的更新）
const FORCE = args?.force === true
// args.dirs 限定扫描的 raw/sources 子目录（默认全量）
const SCAN_DIRS = args?.dirs || null

// ===== Phase 1: 确定性探测 =====
// 改进重点：不依赖 LLM 读 log.md 猜测（LLM 会误判 / 遗漏）
// 而是：(1) find 列出所有原始文件 (2) grep 提取已摄入引用 (3) JS 集合差
phase('探测')
log('用 find + grep 确定性对比原始文件 vs 已摄入记录')

// 1a. find 列出 raw/sources 下所有可 ingest 的文件
const RAW_FILES_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对 WIKI_ROOT 的路径，如 raw/sources/知识工程/xxx.md' },
          basename: { type: 'string', description: '文件名（含扩展名）' },
          direction: { type: 'string', description: 'raw/sources/ 下的直接子目录名' },
        },
        required: ['path', 'basename', 'direction']
      }
    }
  },
  required: ['files']
}

const scanTarget = SCAN_DIRS
  ? SCAN_DIRS.map(d => `${WIKI_ROOT}/raw/sources/${d}`).join(' ')
  : `${WIKI_ROOT}/raw/sources`

const rawFilesResult = await agent(`运行以下命令，将输出整理为 JSON 列表：

find ${scanTarget} -type f \\( -name "*.md" -o -name "*.pdf" -o -name "*.txt" -o -name "*.html" -o -name "*.docx" \\) | sort

对每个文件生成：
- path: 相对 ${WIKI_ROOT} 的路径（去掉 ${WIKI_ROOT}/ 前缀，保留 raw/sources/...）
- basename: 文件名（含扩展名，如 xxx.md）
- direction: 该文件在 raw/sources/ 下的直接子目录名（如 raw/sources/知识工程/xxx.md → 知识工程）`, {
  label: 'find-raw-files',
  phase: '探测',
  schema: RAW_FILES_SCHEMA
})

// 1b. grep 提取 wiki 所有页面中 sources: 字段记录的文件引用
const INGESTED_SCHEMA = {
  type: 'object',
  properties: {
    refs: {
      type: 'array',
      items: { type: 'string' },
      description: '从 sources: 字段提取的所有已摄入文件名（basename，如 xxx.md）'
    }
  },
  required: ['refs']
}

const ingestedResult = await agent(`运行以下命令，从 wiki 页面的 sources: 字段提取已摄入文件名：

grep -rh "^sources:" ${WIKI_ROOT}/wiki --include="*.md" 2>/dev/null | tr -d '[]"' | sed 's/sources://g' | tr ',' '\\n' | sed 's/^[[:space:]]*//' | grep -v '^$'

将每行路径取 basename（最后一个 / 之后的部分），去重后返回数组。
示例：如果一行是 "知识工程/foo.md"，basename 是 "foo.md"。`, {
  label: 'grep-ingested-sources',
  phase: '探测',
  schema: INGESTED_SCHEMA
})

// 1c. JS 层做集合差（确定性，不依赖 LLM 判断）
const ingestedBasenames = new Set(
  (ingestedResult?.refs || []).map(r => r.trim().toLowerCase()).filter(Boolean)
)

const allRawFiles = rawFilesResult?.files || []
const newFiles = FORCE
  ? allRawFiles  // force 模式：全量重新 ingest
  : allRawFiles.filter(f => !ingestedBasenames.has(f.basename.toLowerCase()))

log(`探测完成: 原始文件 ${allRawFiles.length} 个，已摄入 ${ingestedBasenames.size} 种，待摄入 ${newFiles.length} 个${FORCE ? '（force 模式）' : ''}`)

if (newFiles.length > 0) {
  log('未摄入文件列表:')
  for (const f of newFiles) log(`  · ${f.path}`)
}

// ===== Phase 2: 摄入 =====
phase('摄入')

if (newFiles.length === 0) {
  log('没有新文件需要摄入，wiki 已是最新状态')
  return { new_files: 0, ingest_result: null }
}

log(`调用 wiki-ingest 处理 ${newFiles.length} 个文件`)
const ingestResult = await workflow('wiki-ingest', {
  root: WIKI_ROOT,
  files: newFiles.map(f => ({ path: f.path, direction: f.direction })),
})

return {
  new_files: newFiles.length,
  files: newFiles.map(f => f.path),
  ingest_result: ingestResult,
}
