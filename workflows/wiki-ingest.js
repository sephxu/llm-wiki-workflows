
export const meta = {
  name: 'wiki-ingest',
  description: '将 raw/sources 中的源文件 ingest 为 wiki 页面',
  whenToUse: '当需要将 raw/sources/ 下的原始素材整理为 wiki 页面时使用',
  phases: [
    { title: '分析', detail: '理解源文件内容和现有 wiki 的关系' },
    { title: '生成', detail: '创建 wiki 页面并写入文件' },
    { title: '互链', detail: '两阶段：发现反向链接候选 → 精准替换（不重写页面）' },
    { title: '收尾', detail: '更新 index.md、overview.md 和 log.md' },
  ],
}

const WIKI_ROOT = args?.root ?? (await agent('运行 pwd 并只返回绝对路径，不要多余文字', {
  label: 'detect-root', schema: {type:'object', properties:{path:{type:'string'}}, required:['path']}
})).path

// args 格式: { files: [{ path: "raw/sources/...", direction: "my-topic" }, ...] }
// path 支持相对路径（相对 WIKI_ROOT）或绝对路径；direction 通常取 raw/sources/ 下的子目录名
const FILES = (args?.files || []).map(f => ({
  path: f.path.startsWith('/') ? f.path : `${WIKI_ROOT}/${f.path}`,
  direction: f.direction || 'general',
}))

if (FILES.length === 0) {
  log('错误: 未指定源文件。请通过 args.files 传入，格式: [{path, direction}]')
  return { error: 'no files specified' }
}

const today = args?.date || (await agent('运行 date +%F 并只返回日期字符串，不要多余文字', {
  label: 'get-date', schema: {type:'object', properties:{date:{type:'string'}}, required:['date']}
})).date

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    source_path: { type: 'string' },
    summary: { type: 'string', description: '源文件核心内容 3-5 句' },
    pages_to_create: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'kebab-case 文件名（不含 .md）' },
          type: { type: 'string', enum: ['source', 'synthesis', 'entity', 'concept', 'plan', 'decision', 'meeting', 'query'] },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string', description: '为什么选这个类型' },
        },
        required: ['slug', 'type', 'title', 'tags', 'rationale']
      }
    },
    pages_to_update: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          what_to_add: { type: 'string' },
        },
        required: ['slug', 'what_to_add']
      }
    },
    related_existing: {
      type: 'array',
      items: { type: 'string' },
      description: '与此源文件相关的现有 wiki 页面 slug 列表'
    }
  },
  required: ['source_path', 'summary', 'pages_to_create', 'pages_to_update', 'related_existing']
}

const GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    pages_written: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '写入的完整文件路径' },
          slug: { type: 'string' },
          type: { type: 'string' },
          title: { type: 'string' },
          action: { type: 'string', enum: ['created', 'updated'] },
        },
        required: ['path', 'slug', 'type', 'title', 'action']
      }
    }
  },
  required: ['pages_written']
}

// ===== Stage 1: 分析 =====
phase('分析')
log(`开始分析 ${FILES.length} 个源文件`)

const analyses = await pipeline(
  FILES,
  (file) => agent(`你是一个知识库管理员。读取以下源文件并分析应该如何 ingest 到 wiki 中。

源文件路径: ${file.path}
所属工作方向: ${file.direction}

同时读取这些文件了解当前 wiki 状态:
- ${WIKI_ROOT}/wiki/index.md（已有页面列表）
- ${WIKI_ROOT}/schema.md（页面类型定义）

分析规则:
1. 判断源文件内容适合创建什么类型的 wiki 页面
2. 检查 index.md 中是否已有覆盖相同主题的页面，避免重复创建
3. 如果现有页面部分覆盖了源文件内容，标记为 pages_to_update
4. 列出所有相关的现有页面 slug
5. 源文件是外部文档摘要用 source 类型，月报/周报/跨主题综合用 synthesis 类型
6. 页面标题和内容使用中文`, {
    label: `analyze:${file.path.split('/').pop()}`,
    phase: '分析',
    schema: ANALYSIS_SCHEMA
  })
)

const validAnalyses = analyses.filter(Boolean)
log(`分析完成: ${validAnalyses.length}/${FILES.length} 成功`)

// ===== Stage 2: 生成 =====
phase('生成')
log('开始生成 wiki 页面')

const generations = await pipeline(
  validAnalyses,
  (analysis) => agent(`你是一个知识库管理员。基于以下分析结果，创建或更新 wiki 页面。

分析结果:
${JSON.stringify(analysis, null, 2)}

操作:
1. 读取源文件 ${analysis.source_path} 获取完整内容
2. 对于 pages_to_create 中的每个页面:
   - 根据 schema.md 中的类型决定目录（如 source → wiki/sources/, synthesis → wiki/synthesis/）
   - 创建文件，包含完整的 YAML frontmatter（type/title/tags/related/created/updated）
   - created 和 updated 都填 ${today}
   - related 字段填入 analysis.related_existing 中的 slug
   - 正文从源文件提炼，保留关键信息，使用中文
   - 在正文中适当使用 [[wikilink]] 引用已有页面
3. 对于 pages_to_update 中的每个页面:
   - 读取现有文件
   - 在合适位置追加新信息（不要删除现有内容）
   - 更新 updated 日期

wiki 根目录: ${WIKI_ROOT}
写入文件时使用完整的绝对路径。`, {
    label: `generate:${analysis.source_path.split('/').pop()}`,
    phase: '生成',
    schema: GENERATE_SCHEMA
  })
)

const validGenerations = generations.filter(Boolean)
const allPagesWritten = validGenerations.flatMap(g => g.pages_written)
log(`生成完成: 共写入 ${allPagesWritten.length} 个页面`)

// ===== Stage 3: 互链（两阶段：发现 → 精准替换）=====
phase('互链')

if (allPagesWritten.length > 0) {
  const newPagesSummary = allPagesWritten.map(p =>
    `slug: ${p.slug}, title: ${p.title}, type: ${p.type}`
  ).join('\n')

  // Phase 3a: 发现 — LLM 返回需要补充反向链接的候选列表（JSON），不修改任何文件
  const BACKLINK_SCHEMA = {
    type: 'object',
    properties: {
      substitutions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string', description: '需要修改的已有页面相对路径（如 wiki/concepts/foo.md）' },
            term: { type: 'string', description: '页面正文中实际出现的、待包裹为 [[]] 的精确原文字符串' },
            target: { type: 'string', description: '目标新页面的 slug' },
          },
          required: ['file', 'term', 'target']
        }
      }
    },
    required: ['substitutions']
  }

  const discovery = await agent(`你是知识库管理员。以下是刚刚 ingest 的新页面列表：
${newPagesSummary}

任务：扫描 ${WIKI_ROOT}/wiki/ 下已有页面，找出哪些已有页面的正文中出现了新页面涵盖的主题，但尚未用 [[wikilink]] 引用。

步骤：
1. 读取 ${WIKI_ROOT}/wiki/index.md 了解所有现有页面
2. 对可能相关的已有页面读取内容
3. 如正文（--- 之后的部分）出现了与新页面高度匹配的术语/概念名称，且未被 [[ ]] 包裹，记录：
   - file: 已有页面相对 ${WIKI_ROOT} 的路径（如 wiki/concepts/foo.md）
   - term: 页面中实际出现的精确文字（必须与原文完全一致，不要修改）
   - target: 对应新页面的 slug
4. 每个 (file, target) 组合只记录一次（选最准确的首次出现 term）
5. 只在语义强相关时记录，不要强行链接
6. 不要修改任何文件，只返回 JSON 列表`, {
    label: 'discover-backlinks',
    phase: '互链',
    schema: BACKLINK_SCHEMA
  })

  const subs = discovery?.substitutions || []
  log(`互链发现：${subs.length} 处需补充反向链接`)

  if (subs.length > 0) {
    // Phase 3b: 精准替换 — 按文件分组，每个 agent 只负责一个文件的所有替换
    // 这样 LLM 拿到的是"修改哪个文件、替换什么"的精确指令，而不是"重写页面"
    const byFile = {}
    for (const s of subs) {
      if (!byFile[s.file]) byFile[s.file] = []
      byFile[s.file].push(s)
    }

    await parallel(
      Object.entries(byFile).map(([file, fileSubs]) => () =>
        agent(`对文件 ${WIKI_ROOT}/${file} 执行精准 wikilink 替换：

${fileSubs.map(s => `- 将正文中的「${s.term}」（第一次出现）替换为 [[${s.target}|${s.term}]]`).join('\n')}

严格规则（违反则终止操作）：
1. 读取文件完整内容
2. 对每条替换：在 frontmatter（---）结束之后的正文部分，找第一次出现的精确字符串
3. 如该术语已被 [[ ]] 包裹，或在代码块 / 引用块内，跳过
4. 只做字符串替换，不修改任何其他内容（不添加文字、不改变格式、不更新 frontmatter）
5. 将修改后的完整文件内容写回原路径`, {
          label: `apply-links:${file.split('/').pop()}`,
          phase: '互链'
        })
      )
    )
    log(`互链完成：修改了 ${Object.keys(byFile).length} 个已有页面，补充 ${subs.length} 处 [[wikilink]]`)
  } else {
    log('互链：无需补充反向链接')
  }
}

// ===== Stage 4: 收尾 =====
phase('收尾')

await agent(`你是一个知识库管理员。完成以下收尾工作:

刚刚写入的页面:
${allPagesWritten.map(p => `- ${p.slug} (${p.type}): ${p.title} → ${p.path}`).join('\n')}

任务:
1. 读取 ${WIKI_ROOT}/wiki/index.md
2. 在对应的类型分组下注册新页面（格式: - [[slug]] — 一行描述），不要重复注册已有页面
3. 如果 index.md 中没有对应的分组标题，添加分组
4. 读取 ${WIKI_ROOT}/wiki/overview.md，根据新增内容更新全局概览（若无需更新则跳过）
5. 读取 ${WIKI_ROOT}/wiki/log.md，追加一条操作日志:
   格式: ## [${today}] ingest | <本次 ingest 的主题>

   简要说明新增了哪些页面、更新了哪些已有页面。`, {
  label: 'finalize',
  phase: '收尾',
})

return { files_processed: FILES.length, pages_written: allPagesWritten }
