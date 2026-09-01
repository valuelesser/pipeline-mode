# 流水线模式（Pipeline Mode）— 设计与实现说明

> 本文档说明「流水线模式」这个 Agent preset 的背景、设计演进、当前实现、验证记录与使用方法。它服务于新会话的开发者，也作为该模式的可维护性文档。

---

## 1. 项目概述

**「流水线模式」（`pipeline`）** 是 DSH 上一个新建的 Agent preset（`~/.dsh/.agent-presets/pipeline/`）。它把一份"多子代理流水线提示词"（Planner → Executor → Reviewer，串行阶段、结构化交接、最多 3 轮返工）从**纯 prompt 驱动**升级为**代码驱动的 LangGraph 风格条件循环图**，运行在 DSH 原生的 `workflow` 引擎上。

核心特性：

- **Planner → Executor → Reviewer 三阶段**，每阶段一个子代理，输出经 **JSON Schema 强校验**；
- **Reviewer FAIL → 自动返工**：issues 原样喂回下一轮 Planner，最多 3 轮，通过即止；
- **自适应并行**：只有"独立步骤 ≥ 2"才真正并行扇出 + 双 Reviewer，否则走紧凑批处理路径，不为简单任务浪费 agent；
- **输出语言跟随用户**：通过 `args.language` 传递，plan/execution/review/issues 都用用户输入语言输出；
- **英文思考协议**：模型内部思考用英文，并以 `We need..` 开头（`when you think, think in ENGLISH, start with "We need.."`）。

---

## 2. 背景与动机

### 2.1 原始需求

用户提供了一份流水线提示词模板：

- **Planner**：只规划，把任务拆成步骤，定义目标/输入/输出/验收标准；
- **Executor**：只执行，严格按计划产出文件/代码/文本，不修改计划、不扩范围；
- **Reviewer**：只检查，逐项对照验收标准，输出 PASS / FAIL（FAIL 附 issues）；
- **循环**：FAIL → issues 交给 Planner 返工，最多 3 轮；PASS 则结束；
- **交接块**：`<handoff from=".." to=".." status="READY"><payload>..</payload></handoff>`。

最初方案是把这份提示词整个塞进 preset 的 persona，让模型凭自觉走流程。该方案被放弃（见 2.3）。

### 2.2 为什么不用真实的 LangGraph.js？

用户提议"既然 LangGraph 是成熟体系，能否直接复制"。评估结论是**不划算**：

| 障碍 | 说明 |
|---|---|
| 依赖安装 | preset 是 YAML 组合文件，动态插件无法 `npm install`；要跑 LangGraph.js 需先装进 Profile/部署并写 Host 插件 |
| 模型路由 | LangGraph 自带 ChatModel 接口，而 DSH 的模型路由藏在 `dsh-llm` 内部，对接是实打实的适配工程 |
| 持久化 | LangGraph 的 checkpointer 要落库，DSH 有自己的一套 |
| 规模不匹配 | 目标只是一张 3 节点条件循环图，为一个循环引入整套外部框架属杀鸡用牛刀 |

**结论**：DSH 的 `workflow` 工具本身就是成熟的图/流水线编排器（节点=agent 调用、边=阶段流转、`parallel()`=并行扇出、结果=显式状态传递），语义与 LangGraph 一一对应，且模型路由天然打通、零外部依赖。因此选择"复制 LangGraph 的架构思想，复用 DSH 原生引擎"。

### 2.3 设计演进

| 版本 | 形态 | 问题 |
|---|---|---|
| v0（放弃） | 纯 prompt 预设：persona 文本让模型手写三阶段与 XML 交接 | 靠模型自觉，不稳定；用户转向"成熟体系" |
| v1 链式 | workflow 脚本：Planner→Executor→Reviewer 三个 `agent()` 节点，JSON Schema 强校验，FAIL 返工循环（≤3 轮） | 仍是链式，没体现非线性优势 |
| v2 非线性 | 独立步骤**并行扇出** + join；**双并行 Reviewer** + join | 无条件并行：简单任务也开并行，浪费 agent |
| v3 自适应（当前） | 去掉 `mode` 字段，用**硬规则** `independentSteps >= 2` 决定是否扇出；简单任务走紧凑批处理 | — |

---

## 3. 当前设计（v3 自适应）

### 3.1 图结构

```
                        ┌── Executor(独立步骤1) ──┐        ┌── Reviewer A(合规) ──┐
Planner ──┬─(独立步骤≥2)─┤── Executor(独立步骤2) ─├─ join ─┤                      ├─ join → PASS
          │             └── Executor(独立步骤N) ─┘        └── Reviewer B(质量) ──┘   │
          │             └── Executor(依赖步骤,按序)─┘                                  │ FAIL(issues)──┐
          └─(否则)─▶ 单 batch executor 按序执行全部步骤 ─▶ 单综合 Reviewer ─────────────┘              │
                                                                                        ▲               │
                                                                                        └── 新一轮 Planner(最多3轮) ─┘
```

### 3.2 各阶段

- **Planner**：输出 `{ goal, steps[] }`，每步含 `id / action / input / output / acceptance / independent`。
  - `independent: true` **仅当**该步产出自包含的独立交付物（如独立文件/模块）且不依赖其它步骤输出；合并/汇总类步骤（如写 README 汇总各模块）与琐碎步骤一律 `false`。
- **Executor**：
  - **扇出路径**：每个独立步骤一个 agent **并行执行**，依赖步骤在并行批次后**按序执行**（可读前序结果）；每步输出 `{ step_id, status: done|blocked|failed, output, notes }`。
  - **紧凑路径**：**一个** batch executor 按序执行全部步骤，返回 `{ results: [同形结果] }`。
- **Reviewer**：
  - 扇出路径：**两个并行 Reviewer**（合规：每步对 acceptance；质量：整体对目标/连贯/证据），join 判定。
  - 紧凑路径：**一个**综合 Reviewer（合规+质量合一）。
  - 输出 `{ status: PASS|FAIL, summary, issues[] }`；FAIL 的 issues **按 `location|problem` 去重合并**后喂给下一轮 Planner。
- **循环**：`roundPassed = 每个 reviewer 都 PASS`；否则 `rounds >= 3` 时停止，返回未解决问题清单。

### 3.3 自适应硬规则（关键）

```js
const independentSteps = plan.steps.filter(s => s.independent === true)
const fanOut = independentSteps.length >= 2   // 只有 ≥2 个独立步骤才并行
```

- 为什么是硬规则而不是让模型判断"要不要并行"？—— 早期版本加过 `mode: compact|parallel` 字段由 Planner 选择，实测发现 **Planner 会把"3 个独立模块"正确标成 independent，却把 mode 选成 compact，结果扇出被 gate 住**。多一个 LLM 判断层 = 多一处不可靠。最终让"独立标记"（可解释、按交付物粒度判断）驱动，代码只做数量判断。

### 3.4 强校验替代 XML 交接

用户的提示词用 `<handoff>`/`<plan>`/`<execution>`/`<review>` XML 块做阶段间交接，靠模型自觉维护。本实现改为每个阶段子代理绑定 **JSON Schema**，输出不合格（缺字段、字段类型错、枚举越界）直接被 `agent()` 拒绝：

- Planner → `plannerSchema`（含 `independent` 布尔，必填）
- Executor → `stepResultSchema`（`status` 枚举 `done|blocked|failed`）/ `batchResultSchema`
- Reviewer → `reviewerSchema`（`status` 枚举 `PASS|FAIL`，`issues[]` 必填字段）

### 3.5 语言与思考协议

```js
const LANGUAGE = args.language || 'English'
const THINK = 'When you think, think in ENGLISH, and start with "We need.." to frame the next step.'
const LANG_LINE = 'Write ALL of your output ... in the user\'s language: ' + LANGUAGE + ' ...'
```

- **输出语言**：控制器从用户消息检测语言 → 经 `args.language` 传入 → 每个角色 brief 追加 `LANG_LINE`，保证 plan/execution/review/issues 与用户输入同语言。
- **思考语言**：内部思考固定英文，`We need..` 开头（与输出语言解耦）。
- persona 中亦有对应 **THINKING PROTOCOL** 与 **LANGUAGE RULE**。

---

## 4. 文件结构

```
~/.dsh/.agent-presets/pipeline/
├── preset.yml                              # 显示元数据（名称/描述）
├── agent.cordis.yml                        # preset 组成（persona + 全套工具 + 自带 skill 挂载）
└── skills/pipeline-runner/
    └── SKILL.md                            # 验证过的 workflow 脚本模板 + 角色定义 + 用法
```

- **`preset.yml`**：`name: "流水线模式"` + ADAPTIVE 描述。注意必须加引号——描述里 `: `（冒号+空格）会让 js-yaml 解析失败，导致 picker 不显示名称/描述（历史坑，见 §6.2）。
- **`agent.cordis.yml`**：从 `standard` 复制，改动两点：
  1. `persona` 行换成流水线控制器人格（英文 + 思考协议 + 语言规则 + 自适应说明）；
  2. `skill-filesystem` 行加 `customSkillDirs` 指向预设自带 `skills/`（`baseUrl` 相对路径），使 `pipeline-runner` skill 随预设挂载。
- **`SKILL.md`**：前端说明（图、用法、阶段与强校验）+ 末尾 **15KB 的 JS 脚本模板**，控制器把它原样粘贴进 `workflow` 工具的 `script` 参数，只经 `args.task` / `args.language` 传数据。

---

## 5. workflow 脚本模板要点

脚本模板整体是一个"有条件循环图"，用 `workflow` 引擎的原语实现：

| LangGraph 概念 | 本模板实现 |
|---|---|
| Node（一次 agent 调用） | `await agent(prompt, { schema, label, phase })` |
| 串行边 | 阶段按序 `await` |
| 并行扇出（Send 风格） | `await parallel(independentSteps.map(step => async () => agent(...)))` |
| join / 屏障 | 并行结果按索引归并进 `execResults` |
| 条件边（FAIL→返工） | `if (!roundPassed && rounds < MAX_ROUNDS) { reworkText = ...; continue }` |
| 终止（PASS / 超轮） | `break`；`rounds >= MAX_ROUNDS` |
| 状态传递 | 每轮产生的 `plan / stepResults / reviews` 作为下轮输入 |

关键变量：

- `MAX_ROUNDS = 3` — 返工上限；
- `fanOut` — 是否扇出（见 §3.3）；
- `reworkText` — 去重合并后的 issues JSON，拼进下轮 Planner 的 `REWORK ISSUES`；
- 返回 `{ status, rounds, adaptive: { totalSteps, parallelSteps, dependentSteps, parallelReviewers }, reworkAutoLooped, goal, reviewSummaries, unresolvedIssues? }`。

---

## 6. 验证记录

### 6.1 功能验证（真实运行）

| 场景 | 版本 | 执行形状 | agent 数 | 结果 |
|---|---|---|---|---|
| 简单任务（链式） | v1 | 3 节点串行 | 3 | PASS 1轮 |
| 强制 FAIL → 返工 | v1 | 串行 + 回环 | 9 | 返工后 PASS（3轮内） |
| 多独立步骤（非线性） | v2 | 2 并行 + 1 依赖 + 2 Reviewer | 12 | PASS（含返工） |
| 中文任务 + `args.language=Chinese` | v2 | 4 步 + 双 Reviewer | 19 | 真实返工 1 次 → PASS；**输出全中文** |
| 宣传语（无并行需求） | v3 | **compact：1 batch executor + 1 Reviewer** | **3** | PASS 1轮 |
| 3 独立模块 + 依赖 README | v3 | **fanOut: true**（3 并行 + 1 依赖 + 2 Reviewer） | **7** | PASS 1轮；`plannerFlags` 3×`independent:true` |

**两个关键实测结论**：

1. **自适应生效**：同一宣传语任务，v2 用 19 个 agent（含并行），v3 降到 **3 个**（无并行）——"无并行需求不开并行"成立；
2. **并行在真需要时保留**：3 独立模块任务 `fanOut: true`，7 个 agent 真扇出 + 双 Reviewer——非线性优势未丢失。

### 6.2 工程修复记录

| 问题 | 根因 | 修复 |
|---|---|---|
| 选中模式但无名称/描述 | `preset.yml` 描述含未加引号的 `: `（`controller: Planner`），js-yaml 整文件解析失败，`readPresetMetadata` 降级返回空元数据 | 给 `name`/`description` 加引号；roster `list()`/`resolve()` 确认读到名称与描述 |
| 简单任务仍开并行（用户反馈） | v2 无条件扇出 + 双 Reviewer | v3 硬规则 `independentSteps >= 2` + 紧凑路径 |
| Planner 选了 compact 却把模块标 independent | `mode` 字段这一多余 LLM 判断层 gate 住了扇出 | 去掉 `mode` 字段，独立标记 + 数量硬规则驱动 |

---

## 7. 使用方法

1. 在 DSH GUI **新开一个会话**，模式选 **「流水线模式」**；
2. 直接给任务（如"写一个 Python 快速排序并配测试"）；若任务有多个相互独立的交付物，可明确说"分别写模块 A、B、C，再写 README 汇总"；
3. 控制器加载 `pipeline-runner` skill → 调用 `workflow` 工具（脚本原样粘贴模板，`args.task` 传任务、`args.language` 传语言）→ 收到结构化结果后按用户语言汇报；
4. 汇报内容：`status`（PASS/FAIL/ABORTED）、`rounds`、`adaptive` 形状（总/并行/依赖步骤数、Reviewer 数）、检查摘要；FAIL 时附未解决问题清单与建议。

---

## 8. 已知限制与后续方向

- **无强制开关**：模板未暴露 `args.mode`，无法手动强制"并行/紧凑"；如需可加 `const MODE = args.mode ?? (fanOut ? 'parallel' : 'compact')` 覆盖入口。
- **角色 prompt 可调**：Planner 的 `independent` 语义、Reviewer 的检查粒度、`MAX_ROUNDS` 上限都在 `SKILL.md` 模板内，改模板即可，无需重建预设。
- **真实 LangGraph 集成**：目前明确不引入；若未来需要 LangGraph 的 checkpointer 持久化、interrupt 人类介入等特性，可单独评估 Host 插件方案（工程量大，见 §2.2）。
- **跨会话产物**：Executor 产出写入会话工作区；如需固定产物目录或跨会话引用，需额外约定。
