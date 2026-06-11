
export const meta = {
  name: 'wiki-sync',
  description: '检测 raw/sources 中尚未 ingest 的源文件，自动调用 wiki-ingest 增量摄入',
  whenToUse: '向 raw/sources/ 添加了新素材后，或定期巡检时使用；自动找出未入库的文件并 ingest',
  phases: [
    { title: '探测', detail: '对比 raw/sources 与 wiki 摄入记录，找出未入库文件' },
    { title: '摄入', detail: '调用 wiki-ingest 子工作流处理新文件' },
  ],
}

const WIKI_ROOT = args?.root ?? (await agent('运行 pwd 并只返回绝对路径，不要多余文字', {
  label: 'detect-root', schema: {type:'object', properties:{path:{type:'string'}}, required:['path']}
})).path

// ===== Phase 1: 探测 =====
phase('探测')
log('对比 raw/sources 与 wiki 摄入记录')

const DETECT_SCHEMA = {
  type: 'object',
  properties: {
    new_files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对 WIKI_ROOT 的路径，如 raw/sources/知识工程/xxx.md' },
          direction: { type: 'string', description: '所属工作方向（来自目录名）: 知识工程/Agent工程/AI-Delivery/跨方向' },
          reason: { type: 'string', description: '判定为未摄入的依据' },
        },
        required: ['path', 'direction', 'reason']
      }
    },
    already_ingested: { type: 'array', items: { type: 'string' }, description: '已摄入的源文件路径' },
  },
  required: ['new_files', 'already_ingested']
}

const detection = await agent(`你是知识库管理员。找出 raw/sources/ 中尚未被 ingest 进 wiki 的源文件。

步骤:
1. 列出 ${WIKI_ROOT}/raw/sources/ 下所有 .md 文件（递归，目录名即工作方向）
2. 读取 ${WIKI_ROOT}/wiki/log.md，找出历史 ingest 记录中提到的源文件
3. 同时 grep ${WIKI_ROOT}/wiki/ 下页面中"来源:"或"source:"对 raw/sources 路径的引用
4. 两者都没出现过的源文件 → 判定为未摄入（new_files）

注意: 文件名可能在记录中以简写出现，对比时按文件名匹配而不只是完整路径。拿不准的宁可归入 new_files（ingest 流程本身会去重）。`, {
  label: 'detect-new-sources',
  phase: '探测',
  schema: DETECT_SCHEMA
})

const newFiles = detection.new_files
log(`探测完成: ${newFiles.length} 个未摄入文件, ${detection.already_ingested.length} 个已摄入`)

// ===== Phase 2: 摄入 =====
phase('摄入')

if (newFiles.length === 0) {
  log('没有新文件需要摄入')
  return { new_files: 0, ingest_result: null }
}

log(`调用 wiki-ingest 处理 ${newFiles.length} 个文件`)
const ingestResult = await workflow('wiki-ingest', {
  root: WIKI_ROOT,
  files: newFiles.map(f => ({ path: f.path, direction: f.direction })),
})

return { new_files: newFiles.length, files: newFiles.map(f => f.path), ingest_result: ingestResult }
