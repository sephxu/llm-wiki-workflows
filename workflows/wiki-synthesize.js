
export const meta = {
  name: 'wiki-synthesize',
  description: '发现跨源高频主题，生成/更新 wiki/synthesis/ 综合分析页面',
  whenToUse: '多次 ingest 后，需要对知识库中反复出现的主题进行跨源综合分析时使用',
  phases: [
    { title: '发现', detail: '提取所有 source 页的核心主题，找出被 ≥3 个来源覆盖的交叉主题' },
    { title: '规划', detail: 'LLM 判断哪些主题值得生成/更新综合页，检查已有 synthesis 页' },
    { title: '生成', detail: '并行为每个综合主题创建/更新 wiki/synthesis/ 页面' },
    { title: '收尾', detail: '更新 index.md 和 log.md' },
  ],
}

const WIKI_ROOT = args?.root ?? (await agent('运行 pwd 并只返回绝对路径，不要多余文字', {
  label: 'detect-root', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
})).path

// args.topics: 手动指定要综合的主题 slug 列表（跳过自动发现）
// args.min_sources: 判断为"高频主题"的最低来源数（默认 2）
const MANUAL_TOPICS = args?.topics || null
const MIN_SOURCES = args?.min_sources || 2

const today = (await agent('运行 date +%F 并只返回日期字符串', {
  label: 'get-date', schema: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] }
})).date

// ===== Phase 1: 发现 =====
// 提取各 source 页覆盖的主题（slug 引用），找出交叉主题
phase('发现')

let synthesisTopics = []

if (MANUAL_TOPICS) {
  synthesisTopics = MANUAL_TOPICS.map(slug => ({ slug, source_count: 0, sources: [], rationale: '手动指定' }))
  log(`手动指定 ${synthesisTopics.length} 个主题，跳过自动发现`)
} else {
  const DISCOVER_SCHEMA = {
    type: 'object',
    properties: {
      source_pages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path:     { type: 'string', description: 'source 页相对路径' },
            title:    { type: 'string' },
            topics:   { type: 'array', items: { type: 'string' }, description: '该来源页正文/related 中引用的实体/概念 slug 列表' },
            keywords: { type: 'array', items: { type: 'string' }, description: '该来源页的核心关键词（最多 5 个）' },
          },
          required: ['path', 'title', 'topics', 'keywords']
        }
      }
    },
    required: ['source_pages']
  }

  const discovery = await agent(`你是知识库管理员。读取所有来源摘要页（source 类型），提取每个来源覆盖的主题。

步骤：
1. 运行命令找到所有 source 类型页面：
   \`\`\`bash
   find ${WIKI_ROOT}/wiki/sources -name "*.md" 2>/dev/null
   grep -rl "^type: source" ${WIKI_ROOT}/wiki --include="*.md" 2>/dev/null
   \`\`\`
2. 对每个 source 页，读取其 frontmatter（related 字段）和正文中的 [[wikilink]] 引用
3. 提取该来源页"关于什么主题"：slug 引用列表 + 核心关键词

注意：关键是准确提取各来源页引用了哪些实体/概念 slug。`, {
    label: 'discover-sources',
    phase: '发现',
    schema: DISCOVER_SCHEMA
  })

  const sourcePages = discovery?.source_pages || []
  log(`发现 ${sourcePages.length} 个来源页`)

  // JS 层统计各主题被几个来源引用
  const topicCount = {}
  const topicSources = {}
  for (const sp of sourcePages) {
    for (const topic of (sp.topics || [])) {
      topicCount[topic] = (topicCount[topic] || 0) + 1
      if (!topicSources[topic]) topicSources[topic] = []
      topicSources[topic].push(sp.path)
    }
  }

  // 筛选被 MIN_SOURCES 个以上来源覆盖的主题
  const hotTopics = Object.entries(topicCount)
    .filter(([, count]) => count >= MIN_SOURCES)
    .sort(([, a], [, b]) => b - a)
    .map(([slug, count]) => ({ slug, source_count: count, sources: topicSources[slug] }))

  log(`发现 ${hotTopics.length} 个被 ≥${MIN_SOURCES} 个来源覆盖的主题: ${hotTopics.map(t => `${t.slug}(${t.source_count})`).join(', ')}`)

  synthesisTopics = hotTopics
}

if (synthesisTopics.length === 0) {
  log('没有发现值得综合的高频主题，退出')
  return { topics_found: 0, pages_created: [] }
}

// ===== Phase 2: 规划 =====
// LLM 判断哪些主题值得生成综合页（vs 已有足够深度的概念页），检查已有 synthesis 页
phase('规划')

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    to_create: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic_slug:    { type: 'string', description: '原实体/概念的 slug' },
          synthesis_slug:{ type: 'string', description: '要创建的 synthesis 页的 slug（如 evoloop-architecture-synthesis）' },
          title:         { type: 'string', description: '综合页标题' },
          angle:         { type: 'string', description: '这篇综合页的切入角度（跨源对比/演进脉络/矛盾与张力/实践洞察等）' },
          source_pages:  { type: 'array', items: { type: 'string' }, description: '应纳入的 source 页路径列表' },
          related_pages: { type: 'array', items: { type: 'string' }, description: '相关的 concept/entity/plan 页 slug 列表' },
        },
        required: ['topic_slug', 'synthesis_slug', 'title', 'angle', 'source_pages', 'related_pages']
      }
    },
    to_update: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          existing_path: { type: 'string' },
          what_to_add:   { type: 'string' },
          source_pages:  { type: 'array', items: { type: 'string' } },
        },
        required: ['existing_path', 'what_to_add', 'source_pages']
      }
    },
    skip: {
      type: 'array',
      items: { type: 'object', properties: { slug: { type: 'string' }, reason: { type: 'string' } }, required: ['slug', 'reason'] }
    }
  },
  required: ['to_create', 'to_update', 'skip']
}

const plan = await agent(`你是知识库管理员。以下是发现的高频跨源主题：

${synthesisTopics.map(t => `- ${t.slug}（${t.source_count} 个来源: ${(t.sources||[]).join(', ')}）`).join('\n')}

任务：决定哪些主题值得创建/更新 wiki/synthesis/ 综合分析页。

判断规则：
1. 读取 ${WIKI_ROOT}/wiki/index.md 了解已有页面
   检查 ${WIKI_ROOT}/wiki/synthesis/ 下已有的综合页（只看这个目录，不要扫描其他目录）：
   \`find ${WIKI_ROOT}/wiki/synthesis -name "*.md" 2>/dev/null\`
2. **值得创建** synthesis 页的条件（满足其一）：
   - 多个来源对同一主题有不同视角或存在演进/对比关系
   - 主题跨越了两个以上工作方向（如 Agent工程 + 知识工程）
   - 来源之间存在观点张力或矛盾值得梳理
3. **不需要创建** 的情况：已有足够深度的 concept 页，来源观点高度一致无需进一步综合
4. **值得更新** 的情况：已有 synthesis 页但有新来源材料未覆盖
5. synthesis_slug 用 kebab-case，末尾加 -synthesis 或用描述性名称

读取相关来源页内容以辅助判断。`, {
  label: 'plan-synthesis',
  phase: '规划',
  schema: PLAN_SCHEMA
})

log(`规划完成: 创建 ${plan?.to_create?.length || 0} 个新综合页，更新 ${plan?.to_update?.length || 0} 个，跳过 ${plan?.skip?.length || 0} 个`)
if (plan?.skip?.length) {
  for (const s of plan.skip) log(`  跳过 ${s.slug}: ${s.reason}`)
}

const toCreate = plan?.to_create || []
const toUpdate = plan?.to_update || []

if (toCreate.length === 0 && toUpdate.length === 0) {
  log('没有需要生成或更新的综合页')
  return { topics_found: synthesisTopics.length, pages_created: [], pages_updated: [] }
}

// ===== Phase 3: 生成 =====
// 并行为每个综合主题生成/更新页面
phase('生成')

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '写入的文件路径' },
    slug: { type: 'string' },
    title: { type: 'string' },
    action: { type: 'string', enum: ['created', 'updated'] },
  },
  required: ['path', 'slug', 'title', 'action']
}

// 并行创建新综合页
const createResults = await parallel(
  toCreate.map(item => () => agent(`你是知识库管理员。为以下主题创建一篇深度综合分析页面。

主题: ${item.title}
切入角度: ${item.angle}
文件路径: ${WIKI_ROOT}/wiki/synthesis/${item.synthesis_slug}.md

来源页面（请逐一读取）:
${item.source_pages.map(p => `- ${p}`).join('\n')}

相关概念/实体:
${item.related_pages.map(s => `- [[${s}]]`).join('\n')}

写作要求:
1. Frontmatter 必须包含（YAML 格式）:
   - type: synthesis
   - title: "${item.title}"
   - tags: [相关工作方向]
   - related: [${item.related_pages.join(', ')}]
   - sources: [来源页面路径列表]
   - created: ${today}
   - updated: ${today}

2. 正文结构（根据切入角度选择）:
   - 如果是"演进脉络"：按时间/版本梳理各来源的不同侧重
   - 如果是"跨源对比"：列表或表格对比不同来源的观点
   - 如果是"矛盾与张力"：明确指出各来源的不同立场及潜在矛盾
   - 如果是"实践洞察"：提炼各来源的实践经验和教训

3. 必须包含：
   - 每个核心观点注明来源（[[source-slug]] 形式）
   - 与相关概念页的 [[wikilink]] 交叉引用
   - 结尾的"开放问题"或"待验证假设"小节

4. 使用中文写作，保持客观分析语气`, {
      label: `create-synthesis:${item.synthesis_slug}`,
      phase: '生成',
      schema: WRITE_SCHEMA
    })
  )
)

// 并行更新已有综合页
const updateResults = await parallel(
  toUpdate.map(item => () => agent(`你是知识库管理员。更新以下综合页面，补充新来源的内容：

文件路径: ${WIKI_ROOT}/wiki/synthesis/${item.existing_path.split('/').pop()}
需要补充的内容: ${item.what_to_add}

新来源页面（请读取并提取相关内容）:
${item.source_pages.map(p => `- ${p}`).join('\n')}

操作要求:
1. 读取现有综合页内容
2. 在合适位置补充新来源带来的新视角、新数据或新进展
3. 更新 frontmatter 的 sources 字段（追加新来源）和 updated 日期（${today}）
4. 保留并尊重现有内容，不删除已有分析
5. 如有矛盾或张力，在页面中明确指出`, {
      label: `update-synthesis:${item.existing_path.split('/').pop()}`,
      phase: '生成',
      schema: WRITE_SCHEMA
    })
  )
)

const allWritten = [
  ...createResults.filter(Boolean),
  ...updateResults.filter(Boolean),
]
log(`生成完成: ${createResults.filter(Boolean).length} 个新建，${updateResults.filter(Boolean).length} 个更新`)

// ===== Phase 4: 收尾 =====
phase('收尾')

if (allWritten.length > 0) {
  await agent(`你是知识库管理员。完成综合页生成后的收尾工作:

新生成/更新的综合页:
${allWritten.map(p => `- ${p.slug} (${p.action}): ${p.title} → ${p.path}`).join('\n')}

任务:
1. 读取 ${WIKI_ROOT}/wiki/index.md
2. 在 "## 综合分析" 或 "## Synthesis" 分组下注册新创建的页面（已有分组则追加，无则新建）
   格式: - [[slug]] — 一行描述
3. 在 ${WIKI_ROOT}/wiki/log.md 末尾追加操作记录:
   ## [${today}] synthesize | <主题摘要>

   说明新增了哪些综合分析页、涵盖哪些来源。`, {
    label: 'finalize-synthesis',
    phase: '收尾'
  })
}

return {
  topics_found: synthesisTopics.length,
  pages_created: createResults.filter(Boolean).map(p => p?.slug),
  pages_updated: updateResults.filter(Boolean).map(p => p?.path),
}
