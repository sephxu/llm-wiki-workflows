
export const meta = {
  name: 'wiki-lint',
  description: '检查 wiki 健康度：孤页、断链、index 一致性，可选自动修复。扫描阶段改用 grep 确定性提取。',
  whenToUse: '定期对 wiki/ 做健康检查；args.fix=true 时自动修复发现的问题',
  phases: [
    { title: '扫描', detail: '用 grep/find 确定性提取页面清单、wikilink 图与 frontmatter 字段' },
    { title: '诊断', detail: 'JS 层确定性计算孤页/断链/related 完整性/stale-index/缺失 frontmatter' },
    { title: '修复', detail: 'fix 模式下并行修复各类问题' },
    { title: '报告', detail: '汇总结果，写入 log.md' },
  ],
}

const WIKI_ROOT = args?.root ?? (await agent('运行 pwd 并只返回绝对路径，不要多余文字', {
  label: 'detect-root', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
})).path
const FIX = args?.fix === true

// ===== Phase 1: 确定性扫描（grep-based，不依赖 LLM 读取每个页面）=====
// 改进重点：LLM 原来负责"读取所有页面并提取 wikilink"，容易遗漏或错误
// 新方案：让 agent 运行 grep/find 命令，返回结构化数据，JS 层做图计算
phase('扫描')
log('用 grep/find 命令确定性扫描 wiki 页面')

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug:     { type: 'string', description: '文件名去掉 .md' },
          path:     { type: 'string', description: '相对 WIKI_ROOT 的路径，如 wiki/concepts/foo.md' },
          title:    { type: 'string' },
          type:     { type: 'string' },
          has_type:  { type: 'boolean', description: 'frontmatter 是否包含 type 字段' },
          has_title: { type: 'boolean', description: 'frontmatter 是否包含 title 字段' },
          outlinks: { type: 'array', items: { type: 'string' }, description: '正文中所有 [[wikilink]] 的 slug（去掉 [[]]，取 | 前部分）' },
          related:  { type: 'array', items: { type: 'string' }, description: 'frontmatter related: 字段的值列表' },
          in_index: { type: 'boolean', description: 'slug 是否在 index.md 中被 [[]] 引用' },
        },
        required: ['slug', 'path', 'title', 'type', 'has_type', 'has_title', 'outlinks', 'related', 'in_index']
      }
    },
    index_slugs: {
      type: 'array', items: { type: 'string' },
      description: 'index.md 中所有 [[slug]] 引用（不含 wiki/ 前缀和 .md 后缀）'
    }
  },
  required: ['pages', 'index_slugs']
}

const scan = await agent(`你是知识库管理员。用 shell 命令批量扫描 wiki，提取结构化信息。

**步骤 1: 列出所有内容页**
\`\`\`bash
find ${WIKI_ROOT}/wiki -name "*.md" \\
  -not -name "index.md" -not -name "log.md" -not -name "overview.md" \\
  | sort
\`\`\`

**步骤 2: 批量提取 wikilink（outlinks）**
对每个 .md 文件运行：
\`\`\`bash
grep -oh '\\[\\[[^\\]|]*' <file> | sed 's/\\[\\[//'
\`\`\`
这提取正文中 [[target]] 或 [[target|label]] 的 target 部分。

**步骤 3: 提取 frontmatter 字段**
对每个文件：
- slug = 文件名去 .md
- path = 相对 ${WIKI_ROOT} 的路径
- type: grep "^type:" frontmatter 区域
- title: grep "^title:" frontmatter 区域
- related: grep "^related:" 并解析数组值
- has_type / has_title: 字段是否存在且非空

**步骤 4: 提取 index.md 中的所有 [[slug]] 引用**
\`\`\`bash
grep -oh '\\[\\[[^\\]]*\\]\\]' ${WIKI_ROOT}/wiki/index.md | sed 's/\\[\\[//;s/\\]\\]//'
\`\`\`

**步骤 5: 判断 in_index**
每个页面的 slug 是否在步骤 4 的结果中。

返回完整 JSON。`, {
  label: 'scan-wiki',
  phase: '扫描',
  schema: SCAN_SCHEMA
})

const pages = scan.pages || []
const indexSlugs = scan.index_slugs || []
const slugSet = new Set(pages.map(p => p.slug.toLowerCase()))
log(`扫描完成: ${pages.length} 个页面，index.md 注册 ${indexSlugs.length} 个条目`)

// ===== Phase 2: 诊断（全部在 JS 层确定性计算）=====
phase('诊断')

// 入站链接计数
const inboundCount = {}
for (const p of pages) {
  for (const l of (p.outlinks || [])) {
    const lk = l.toLowerCase()
    if (slugSet.has(lk) && lk !== p.slug.toLowerCase()) {
      inboundCount[lk] = (inboundCount[lk] || 0) + 1
    }
  }
}

// 孤页：无任何入站链接（overview/direction 类除外）
const orphans = pages
  .filter(p => !inboundCount[p.slug.toLowerCase()] && !['overview', 'direction'].includes(p.type))
  .map(p => p.slug)

// 断链（outlink 指向不存在的 slug）
const brokenLinks = []
for (const p of pages) {
  for (const l of (p.outlinks || [])) {
    if (!slugSet.has(l.toLowerCase())) {
      brokenLinks.push({ from: p.slug, to: l })
    }
  }
}

// 被多处引用但不存在的概念 → 建议创建
const missingMentions = {}
for (const b of brokenLinks) {
  missingMentions[b.to] = (missingMentions[b.to] || 0) + 1
}
const suggestCreate = Object.entries(missingMentions)
  .filter(([, n]) => n >= 2)
  .map(([slug]) => slug)

// 未注册到 index 的页面
const notInIndex = pages.filter(p => !p.in_index).map(p => p.slug)

// 新增: related 字段引用了不存在的 slug
const brokenRelated = []
for (const p of pages) {
  for (const r of (p.related || [])) {
    if (r && !slugSet.has(r.toLowerCase())) {
      brokenRelated.push({ from: p.slug, field: 'related', to: r })
    }
  }
}

// 新增: index.md 中的过期条目（指向已不存在的页面）
const staleIndexEntries = indexSlugs.filter(s => s && !slugSet.has(s.toLowerCase()))

// 新增: 缺失必要 frontmatter 字段（type 或 title）
const missingFrontmatter = pages
  .filter(p => !p.has_type || !p.has_title)
  .map(p => ({
    slug: p.slug,
    path: p.path,
    missing: [!p.has_type && 'type', !p.has_title && 'title'].filter(Boolean)
  }))

log([
  `诊断完成:`,
  `  孤页 ${orphans.length}`,
  `  断链 ${brokenLinks.length}`,
  `  broken related ${brokenRelated.length}`,
  `  建议创建 ${suggestCreate.length}`,
  `  未注册 ${notInIndex.length}`,
  `  过期 index 条目 ${staleIndexEntries.length}`,
  `  缺失 frontmatter ${missingFrontmatter.length}`,
].join('\n'))

const issues = { orphans, brokenLinks, brokenRelated, suggestCreate, notInIndex, staleIndexEntries, missingFrontmatter }

// ===== Phase 3: 修复 =====
phase('修复')

let fixes = null
const hasIssues = orphans.length || brokenLinks.length || brokenRelated.length
  || notInIndex.length || staleIndexEntries.length || missingFrontmatter.length

if (FIX && hasIssues) {
  const fixTasks = []

  // 修复断链（[[wikilink]] 指向不存在的页面）
  if (brokenLinks.length) {
    fixTasks.push(() => agent(`你是知识库管理员。修复以下断链（[[wikilink]] 指向不存在的页面）:

${brokenLinks.map(b => `- ${b.from}.md 中的 [[${b.to}]]`).join('\n')}

现有页面 slug 列表: ${[...slugSet].join(', ')}

修复策略（按优先级）:
1. 如果是已有页面的别名/标题写法 → 改写为正确的 slug（如 [[FSD]] → [[fsd]]）
2. 如果被多个页面引用（${suggestCreate.join(', ') || '无'}）→ 保留链接不动（建议后续创建页面）
3. 如果只有单处引用且无对应概念 → 把 [[xxx]] 改为普通文本 xxx

wiki 根目录: ${WIKI_ROOT}。修改后报告每处断链的处理方式。`, {
      label: 'fix-broken-links', phase: '修复'
    }))
  }

  // 修复 related 字段中的无效 slug
  if (brokenRelated.length) {
    const byPage = {}
    for (const r of brokenRelated) {
      if (!byPage[r.from]) byPage[r.from] = []
      byPage[r.from].push(r.to)
    }
    fixTasks.push(() => agent(`你是知识库管理员。修复以下页面 frontmatter 中 related 字段引用的不存在 slug:

${Object.entries(byPage).map(([slug, broken]) => `- ${slug}: 无效引用 [${broken.join(', ')}]`).join('\n')}

现有页面 slug 列表（可替换为相近的）: ${[...slugSet].join(', ')}

修复策略:
1. 如果有拼写相近的已存在 slug → 替换为正确 slug
2. 否则 → 从 related 字段中删除该无效 slug
3. 只修改 frontmatter 的 related 字段，不修改正文

wiki 根目录: ${WIKI_ROOT}`, {
      label: 'fix-broken-related', phase: '修复'
    }))
  }

  // 修复孤页（无任何入站链接）
  if (orphans.length) {
    fixTasks.push(() => agent(`你是知识库管理员。以下页面是孤页（没有任何其他页面链接到它们）:

${orphans.map(s => `- ${s}`).join('\n')}

任务: 为每个孤页找到 1-3 个语义相关的现有页面，在那些页面的合适位置添加指向孤页的 [[wikilink]]。
只在语义真正相关处添加，不要强行链接。如果某个孤页确实与所有页面无关，报告它。

wiki 根目录: ${WIKI_ROOT}，页面在 wiki/ 各子目录下。`, {
      label: 'fix-orphans', phase: '修复'
    }))
  }

  // 注册未入 index 的页面
  if (notInIndex.length) {
    fixTasks.push(() => agent(`你是知识库管理员。以下页面未在 ${WIKI_ROOT}/wiki/index.md 注册:

${notInIndex.map(s => `- ${s}`).join('\n')}

任务: 读取这些页面的 frontmatter（type/title），在 index.md 对应类型分组下注册（格式: - [[slug]] — 一行描述）。不要重复注册。`, {
      label: 'fix-index', phase: '修复'
    }))
  }

  // 清理 index.md 中的过期条目
  if (staleIndexEntries.length) {
    fixTasks.push(() => agent(`你是知识库管理员。wiki/index.md 中包含以下已删除页面的过期条目（页面文件已不存在）:

${staleIndexEntries.map(s => `- [[${s}]]`).join('\n')}

任务: 从 ${WIKI_ROOT}/wiki/index.md 中删除这些过期条目（整行删除），不修改其他内容。`, {
      label: 'fix-stale-index', phase: '修复'
    }))
  }

  // 补全缺失 frontmatter
  if (missingFrontmatter.length) {
    fixTasks.push(() => agent(`你是知识库管理员。以下页面缺失必要的 frontmatter 字段:

${missingFrontmatter.map(p => `- ${p.path}（缺少: ${p.missing.join(', ')}）`).join('\n')}

任务: 对每个页面:
1. 读取文件内容，根据正文推断缺失字段的值
2. 在 frontmatter（--- 块内）添加缺失字段（type 参考 schema.md，title 从正文 # 标题提取）
3. 不修改其他已有字段和正文

schema 参考: ${WIKI_ROOT}/schema.md`, {
      label: 'fix-missing-frontmatter', phase: '修复'
    }))
  }

  fixes = await parallel(fixTasks)
  log(`修复完成: ${fixes.filter(Boolean).length}/${fixTasks.length} 项成功`)
} else if (!FIX) {
  log('报告模式（args.fix 未开启），跳过修复')
}

// ===== Phase 4: 报告 =====
phase('报告')

const today = (await agent('运行 date +%F 并只返回日期字符串', {
  label: 'get-date', schema: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] }
})).date

await agent(`你是知识库管理员。将本次 lint 结果记录到 ${WIKI_ROOT}/wiki/log.md（在文件末尾追加）:

## [${today}] lint | 健康检查${FIX ? '（已自动修复）' : '（仅报告）'}

- 孤页 (${orphans.length}): ${orphans.join(', ') || '无'}
- 断链 (${brokenLinks.length}): ${brokenLinks.slice(0,5).map(b => `${b.from}→${b.to}`).join(', ')}${brokenLinks.length > 5 ? ` …(+${brokenLinks.length-5})` : ''}
- Related 字段断链 (${brokenRelated.length}): ${brokenRelated.slice(0,5).map(b => `${b.from}.${b.to}`).join(', ')}${brokenRelated.length > 5 ? ` …(+${brokenRelated.length-5})` : ''}
- 建议创建（≥2处引用但不存在）: ${suggestCreate.join(', ') || '无'}
- 未注册到 index (${notInIndex.length}): ${notInIndex.join(', ') || '无'}
- Index 过期条目 (${staleIndexEntries.length}): ${staleIndexEntries.join(', ') || '无'}
- 缺失 frontmatter (${missingFrontmatter.length}): ${missingFrontmatter.map(p => p.slug).join(', ') || '无'}`, {
  label: 'report', phase: '报告'
})

return { pages_scanned: pages.length, issues, fixed: FIX, fix_results: fixes }
