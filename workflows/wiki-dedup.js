
export const meta = {
  name: 'wiki-dedup',
  description: '检测同一主题的不同命名页面，提出合并建议，args.merge=true 时自动合并',
  whenToUse: '多次 ingest 后怀疑出现重复实体/概念页面时使用；默认仅报告，args.merge=true 才执行合并',
  phases: [
    { title: '提取', detail: '提取所有实体/概念页的摘要信息' },
    { title: '检测', detail: 'LLM 判断哪些页面指向同一主题' },
    { title: '合并', detail: 'merge 模式下合并页面并重写全库 wikilink' },
  ],
}

const WIKI_ROOT = args?.root ?? (await agent('运行 pwd 并只返回绝对路径，不要多余文字', {
  label: 'detect-root', schema: {type:'object', properties:{path:{type:'string'}}, required:['path']}
})).path
const MERGE = args?.merge === true
// 可通过 args.dirs 限定扫描范围，默认实体+概念（最容易出现软碰撞的两类）
const DIRS = args?.dirs || ['wiki/entities', 'wiki/concepts']

// ===== Phase 1: 提取 =====
phase('提取')
log(`提取 ${DIRS.join(', ')} 下所有页面摘要`)

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          path: { type: 'string' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          description: { type: 'string', description: '页面内容一两句话概括' },
        },
        required: ['slug', 'path', 'title', 'tags', 'description']
      }
    }
  },
  required: ['summaries']
}

const extraction = await agent(`你是知识库管理员。读取以下目录中所有 .md 页面，对每个页面提取 slug、路径、frontmatter title/tags 和一两句话的内容概括:

${DIRS.map(d => `- ${WIKI_ROOT}/${d}`).join('\n')}

概括要写清"这个页面讲的是什么东西"，便于后续判断两个页面是否在讲同一个东西。`, {
  label: 'extract-summaries',
  phase: '提取',
  schema: EXTRACT_SCHEMA
})

const summaries = extraction.summaries
log(`提取完成: ${summaries.length} 个页面`)

// ===== Phase 2: 检测 =====
phase('检测')

const DETECT_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slugs: { type: 'array', items: { type: 'string' }, description: '疑似指向同一主题的页面 slug 列表（≥2个）' },
          canonical: { type: 'string', description: '建议保留的主页面 slug' },
          reason: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['slugs', 'canonical', 'reason', 'confidence']
      }
    }
  },
  required: ['groups']
}

const detection = await agent(`你是知识库管理员。以下是 wiki 中实体/概念页面的清单，判断其中是否存在"不同命名但指向同一主题"的页面组（例如中英文命名差异、单复数、别名、缩写 vs 全称）:

${JSON.stringify(summaries, null, 2)}

判断规则:
1. 只有当两个页面**确实在讲同一个东西**时才归为一组，"相关但不同"的页面（如一个产品和它的某个功能）不算重复
2. canonical 选信息更完整、命名更规范的那个
3. confidence: high=几乎确定是同一主题, medium=很可能, low=需要人工确认
4. 没有重复就返回空数组，不要强行找`, {
  label: 'detect-duplicates',
  phase: '检测',
  schema: DETECT_SCHEMA
})

const groups = detection.groups
log(`检测完成: 发现 ${groups.length} 组疑似重复`)

// ===== Phase 3: 合并 =====
phase('合并')

let mergeResults = null
const toMerge = groups.filter(g => g.confidence === 'high')

if (!MERGE) {
  log('报告模式（args.merge 未开启），跳过合并')
} else if (toMerge.length === 0) {
  log('没有 high confidence 的重复组，不执行合并')
} else {
  log(`开始合并 ${toMerge.length} 组（仅 high confidence；medium/low 留给人工确认）`)

  mergeResults = await pipeline(
    toMerge,
    (group) => agent(`你是知识库管理员。以下页面被确认为同一主题的重复页面，执行合并:

重复组: ${group.slugs.join(', ')}
保留页面（canonical）: ${group.canonical}
理由: ${group.reason}

合并步骤:
1. 读取组内所有页面的完整内容
2. 把非 canonical 页面的独有信息合并进 canonical 页面正文（保持结构连贯，不要简单拼接）
3. frontmatter 的 tags/related 取并集；type/title/created 保持 canonical 原值；updated 更新为今天（date +%F）
4. 全库重写引用: 在 ${WIKI_ROOT}/wiki/ 下 grep 所有指向被删页面的 [[wikilink]] 和 related 字段引用，改为指向 ${group.canonical}（注意 [[标题形式]] 的引用也要处理）
5. 删除非 canonical 页面文件
6. 更新 ${WIKI_ROOT}/wiki/index.md: 移除被删页面的注册项
7. 在 ${WIKI_ROOT}/wiki/log.md 追加: | <今天日期> | dedup | 合并 ${group.slugs.filter(s => s !== group.canonical).join('、')} → ${group.canonical} | - |

完成后报告: 合并了哪些内容、重写了哪些文件的引用。`, {
      label: `merge:${group.canonical}`,
      phase: '合并',
    })
  )

  log(`合并完成: ${mergeResults.filter(Boolean).length}/${toMerge.length} 组成功`)
}

return {
  pages_scanned: summaries.length,
  duplicate_groups: groups,
  merged: MERGE ? toMerge.map(g => g.canonical) : [],
  pending_manual: groups.filter(g => g.confidence !== 'high'),
}
