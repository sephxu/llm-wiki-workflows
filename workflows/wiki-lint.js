
export const meta = {
  name: 'wiki-lint',
  description: '检查 wiki 健康度：孤页、断链、index 一致性，可选自动修复',
  whenToUse: '定期对 wiki/ 做健康检查；args.fix=true 时自动修复发现的问题',
  phases: [
    { title: '扫描', detail: '构建页面清单与 wikilink 图' },
    { title: '诊断', detail: '在 JS 层确定性计算孤页/断链 + agent 检查 index 一致性' },
    { title: '修复', detail: 'fix 模式下并行修复各类问题' },
    { title: '报告', detail: '汇总结果，写入 log.md' },
  ],
}

const WIKI_ROOT = args?.root ?? (await agent('运行 pwd 并只返回绝对路径，不要多余文字', {
  label: 'detect-root', schema: {type:'object', properties:{path:{type:'string'}}, required:['path']}
})).path
const FIX = args?.fix === true

// ===== Phase 1: 扫描 =====
phase('扫描')
log('扫描 wiki/ 全部页面，提取 wikilink 图')

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: '文件名去掉 .md' },
          path: { type: 'string', description: '相对 WIKI_ROOT 的路径' },
          title: { type: 'string' },
          type: { type: 'string' },
          outlinks: { type: 'array', items: { type: 'string' }, description: '正文+frontmatter related 中所有 [[wikilink]] 的 slug 形式' },
          in_index: { type: 'boolean', description: '是否已在 index.md 注册' },
        },
        required: ['slug', 'path', 'title', 'type', 'outlinks', 'in_index']
      }
    }
  },
  required: ['pages']
}

const scan = await agent(`你是知识库管理员。扫描 ${WIKI_ROOT}/wiki/ 下所有 .md 页面（排除 index.md、log.md、overview.md），对每个页面提取:
1. slug（文件名去掉 .md）
2. 相对路径、frontmatter 中的 title 和 type
3. outlinks: 正文中所有 [[wikilink]] 和 frontmatter related 字段的并集。
   注意 [[标题形式]] 要归一化为 slug 形式（对照其他页面的 title→slug 映射；无法对应的保留原文）
4. in_index: 该 slug 是否在 ${WIKI_ROOT}/wiki/index.md 中被注册

建议用 grep/脚本批量处理，保证不遗漏页面。`, {
  label: 'scan-wiki',
  phase: '扫描',
  schema: SCAN_SCHEMA
})

const pages = scan.pages
const slugSet = new Set(pages.map(p => p.slug))
log(`扫描完成: 共 ${pages.length} 个页面`)

// ===== Phase 2: 诊断（结构性问题在 JS 层确定性计算）=====
phase('诊断')

// 入站链接统计
const inboundCount = {}
for (const p of pages) {
  for (const l of p.outlinks) {
    if (slugSet.has(l) && l !== p.slug) inboundCount[l] = (inboundCount[l] || 0) + 1
  }
}

// 孤页：没有任何入站链接（index/overview 类除外）
const orphans = pages.filter(p => !inboundCount[p.slug] && !['overview', 'direction'].includes(p.type)).map(p => p.slug)

// 断链：outlink 指向不存在的 slug
const brokenLinks = []
for (const p of pages) {
  for (const l of p.outlinks) {
    if (!slugSet.has(l)) brokenLinks.push({ from: p.slug, to: l })
  }
}

// 被多次提及但不存在的概念 → 建议创建
const missingMentions = {}
for (const b of brokenLinks) {
  missingMentions[b.to] = (missingMentions[b.to] || 0) + 1
}
const suggestCreate = Object.entries(missingMentions).filter(([, n]) => n >= 2).map(([slug]) => slug)

// 未注册到 index 的页面
const notInIndex = pages.filter(p => !p.in_index).map(p => p.slug)

log(`诊断完成: 孤页 ${orphans.length}, 断链 ${brokenLinks.length}, 建议创建 ${suggestCreate.length}, 未注册 ${notInIndex.length}`)

const issues = { orphans, brokenLinks, suggestCreate, notInIndex }

// ===== Phase 3: 修复 =====
phase('修复')

let fixes = null
if (FIX && (orphans.length || brokenLinks.length || notInIndex.length)) {
  const fixTasks = []

  if (brokenLinks.length) {
    fixTasks.push(() => agent(`你是知识库管理员。修复以下断链（[[wikilink]] 指向不存在的页面）:

${brokenLinks.map(b => `- ${b.from}.md 中的 [[${b.to}]]`).join('\n')}

现有页面 slug 列表: ${[...slugSet].join(', ')}

修复策略（按优先级）:
1. 如果是已有页面的别名/标题写法 → 改写为正确的 slug 形式
2. 如果被多个页面引用（${suggestCreate.join(', ') || '无'}）→ 保留链接不动（将由人决定是否创建页面）
3. 如果只有单处引用且无对应概念 → 把 [[xxx]] 改为普通文本 xxx

wiki 根目录: ${WIKI_ROOT}。修改后报告每处断链的处理方式。`, {
      label: 'fix-broken-links', phase: '修复'
    }))
  }

  if (orphans.length) {
    fixTasks.push(() => agent(`你是知识库管理员。以下页面是孤页（没有任何其他页面链接到它们）:

${orphans.map(s => `- ${s}`).join('\n')}

任务: 为每个孤页找到 1-3 个语义相关的现有页面，在那些页面的合适位置添加指向孤页的 [[wikilink]]。
只在语义真正相关处添加，不要强行链接。如果某个孤页确实与所有页面无关，报告它（可能需要人工决定归档）。

wiki 根目录: ${WIKI_ROOT}，页面在 wiki/ 各子目录下。`, {
      label: 'fix-orphans', phase: '修复'
    }))
  }

  if (notInIndex.length) {
    fixTasks.push(() => agent(`你是知识库管理员。以下页面未在 ${WIKI_ROOT}/wiki/index.md 注册:

${notInIndex.map(s => `- ${s}`).join('\n')}

任务: 读取这些页面的 frontmatter（type/title），在 index.md 对应类型分组下注册（格式: - [[slug]] — 一行描述）。不要重复注册。`, {
      label: 'fix-index', phase: '修复'
    }))
  }

  fixes = await parallel(fixTasks)
  log(`修复完成: ${fixes.filter(Boolean).length}/${fixTasks.length} 项成功`)
} else if (!FIX) {
  log('报告模式（args.fix 未开启），跳过修复')
}

// ===== Phase 4: 报告 =====
phase('报告')

await agent(`你是知识库管理员。将本次 lint 结果记录到 ${WIKI_ROOT}/wiki/log.md（追加一行，用 date +%F 获取今天日期）:

格式: | <日期> | lint | 孤页 ${orphans.length} 断链 ${brokenLinks.length} 未注册 ${notInIndex.length}${FIX ? '（已自动修复）' : '（仅报告）'} | - |

详情:
- 孤页: ${orphans.join(', ') || '无'}
- 断链: ${brokenLinks.map(b => `${b.from}→${b.to}`).join(', ') || '无'}
- 建议创建的页面（被≥2处引用）: ${suggestCreate.join(', ') || '无'}
- 未注册: ${notInIndex.join(', ') || '无'}`, {
  label: 'report', phase: '报告'
})

return { pages_scanned: pages.length, issues, fixed: FIX, fix_results: fixes }
