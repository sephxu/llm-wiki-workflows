
export const meta = {
  name: 'wiki-ingest',
  description: '将 raw/sources 中的源文件 ingest 为 wiki 页面',
  whenToUse: '当需要将 raw/sources/ 下的原始素材整理为 wiki 页面时使用',
  phases: [
    { title: '分析', detail: '理解源文件内容和现有 wiki 的关系' },
    { title: '生成', detail: '创建 wiki 页面并写入文件' },
    { title: '互链', detail: '在新旧页面间添加 wikilink' },
    { title: '收尾', detail: '更新 index.md 和 log.md' },
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

const ENRICH_SCHEMA = {
  type: 'object',
  properties: {
    links_added: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '被修改的文件路径' },
          added_links: { type: 'array', items: { type: 'string' }, description: '添加的 [[wikilink]] 列表' },
        },
        required: ['file', 'added_links']
      }
    }
  },
  required: ['links_added']
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

// ===== Stage 3: 互链 =====
phase('互链')

if (allPagesWritten.length > 0) {
  const newSlugs = allPagesWritten.map(p => p.slug)

  await agent(`你是一个知识库管理员。刚刚创建/更新了以下 wiki 页面:

${allPagesWritten.map(p => `- ${p.path} (slug: ${p.slug}, type: ${p.type})`).join('\n')}

任务: 检查现有 wiki 页面，在内容相关的地方添加指向新页面的 [[wikilink]]。

步骤:
1. 读取 ${WIKI_ROOT}/wiki/index.md 获取所有页面列表
2. 对于每个可能相关的现有页面，读取内容
3. 如果页面内容提到了新页面涵盖的主题但没有 wikilink，添加 [[${newSlugs.join(']] 或 [[')}]]
4. 只在语义真正相关的地方添加链接，不要强行添加
5. 同时检查新页面是否遗漏了对现有页面的引用

wiki 根目录: ${WIKI_ROOT}`, {
    label: 'enrich-wikilinks',
    phase: '互链',
    schema: ENRICH_SCHEMA
  })
}

// ===== Stage 4: 收尾 =====
phase('收尾')

await agent(`你是一个知识库管理员。完成以下收尾工作:

刚刚写入的页面:
${allPagesWritten.map(p => `- ${p.slug} (${p.type}): ${p.title} → ${p.path}`).join('\n')}

任务:
1. 读取 ${WIKI_ROOT}/wiki/index.md
2. 在对应的类型分组下注册新页面（格式: - [[slug]] — 一行描述）
3. 如果 index.md 中没有对应的分组标题（如 "## 来源 (Sources)"），添加分组
4. 读取 ${WIKI_ROOT}/wiki/log.md，追加一条操作日志:
   格式: | ${today} | ingest | 新增 xxx、xxx 页面 | source: raw/sources/... |

确保不重复注册已有的页面。`, {
  label: 'finalize',
  phase: '收尾',
})

return { files_processed: FILES.length, pages_written: allPagesWritten }
