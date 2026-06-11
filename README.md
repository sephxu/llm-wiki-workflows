# llm-wiki-workflows

Claude Code [Dynamic Workflow](https://docs.anthropic.com/en/docs/claude-code/workflows) 实现，用于维护一个由 LLM 协助管理的个人知识库（Wiki）。

灵感来自 [Andrej Karpathy 的 LLM Wiki 设想](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)：用 LLM 作为持续维护个人知识库的引擎。

## 什么是 Dynamic Workflow

[Claude Code Workflows](https://docs.anthropic.com/en/docs/claude-code/workflows) 是 Claude Code 的多智能体编排机制，允许用 JavaScript 编写结构化的多阶段任务，通过 `agent()`、`pipeline()`、`parallel()` 等原语并发调度多个子 agent 完成复杂操作。

## 知识库结构约定

这套工作流假设知识库采用以下目录结构：

```
raw/sources/            # 原始素材（按工作方向组织）
wiki/                   # Wiki 页面（LLM 维护）
  index.md              # 内容索引
  log.md                # 操作日志（append-only）
  overview.md           # 全局概览
  directions/           # 工作方向
  entities/             # 人/团队/系统/产品
  concepts/             # 技术概念与方法论
  plans/                # 方案设计
  decisions/            # 关键决策
  meetings/             # 会议要点
  queries/              # 待调研问题
  synthesis/            # 跨主题综合分析
  sources/              # 外部文档摘要
schema.md               # 页面类型路由规则
```

## Workflows

### `wiki-ingest.js`

将 `raw/sources/` 中的原始素材摄入为结构化 Wiki 页面。

**四阶段流程：** 分析 → 生成 → 互链 → 收尾

```js
// 用法
Workflow({ name: 'wiki-ingest', args: {
  files: [
    { path: 'raw/sources/知识工程/meeting-notes.md', direction: '知识工程' }
  ]
}})
```

### `wiki-sync.js`

自动探测 `raw/sources/` 中未摄入的文件，增量调用 `wiki-ingest`。

```js
// 用法（无需参数，全自动）
Workflow({ name: 'wiki-sync' })
```

### `wiki-lint.js`

检查 Wiki 健康度：孤页、断链、index 一致性，可选自动修复。

```js
// 仅报告
Workflow({ name: 'wiki-lint' })

// 自动修复
Workflow({ name: 'wiki-lint', args: { fix: true } })
```

**检查项：**
- 孤页（无任何入站 wikilink）
- 断链（`[[wikilink]]` 指向不存在的页面）
- 被 ≥2 处引用但不存在的概念（建议创建）
- 未注册到 `index.md` 的页面

### `wiki-dedup.js`

检测不同命名但指向同一主题的重复页面，提出合并建议。

```js
// 仅报告
Workflow({ name: 'wiki-dedup' })

// 自动合并 high confidence 组
Workflow({ name: 'wiki-dedup', args: { merge: true } })
```

## 安装

将 `workflows/` 目录下的 `.js` 文件复制到你的 Claude Code 项目的 `.claude/workflows/` 目录下即可。

```bash
cp workflows/*.js /your-project/.claude/workflows/
```

## 通用参数

所有 workflow 均支持 `args.root` 参数指定知识库根目录。不传时自动检测当前工作目录。

```js
Workflow({ name: 'wiki-ingest', args: { root: '/path/to/your/wiki', files: [...] } })
```
