# Pipeline Mode（流水线模式）

**[English](README.en.md) | 中文**

一个运行在 [DSH](https://github.com/deepseek-ai/dsh)（DeepSeek Harness）上的 **Agent Preset**：把 Planner → Executor → Reviewer 多子代理流水线实现为 **LangGraph 风格的自适应条件循环图**，跑在 DSH 原生的 `workflow` 引擎上。

> **Preset 与插件的区别**：这是一个 **agent preset**（YAML 组合 + 自带 skill），不是 npm 插件包。DSH 的 preset 发布形态就是"分享一个目录"——复制到用户预设根目录即可安装，无需编译、无依赖。

---

## ✨ 特性

- **Planner → Executor → Reviewer 三阶段**，每阶段一个子代理，输出经 **JSON Schema 强校验**（不合格结果直接拒收，比 XML 交接块可靠）；
- **Reviewer FAIL → 自动返工**：issues 去重合并后原样喂回下一轮 Planner，最多 3 轮，通过即止；
- **自适应并行**：只有"独立步骤 ≥ 2"才真正并行扇出 + 双并行 Reviewer；否则走紧凑批处理路径（1 个 batch executor + 1 个综合 Reviewer），**不为简单任务浪费 agent**；
- **输出语言跟随用户**：经 `args.language` 传递，plan/execution/review/issues 都用用户输入语言输出；
- **英文思考协议**：内部思考用英文并以 `We need..` 开头（输出语言与思考语言解耦）；
- **零外部依赖**：复用 DSH 原生 `workflow` 引擎，模型路由天然打通。

## 🧠 为什么不用真实的 LangGraph.js

| 障碍 | 说明 |
|---|---|
| 依赖安装 | preset 是 YAML 组合，无法 `npm install`；需先装进 Profile/部署再写 Host 插件 |
| 模型路由 | LangGraph 自带 ChatModel 接口，与 DSH 内部 `dsh-llm` 对接是实打实的适配工程 |
| 持久化 | LangGraph 的 checkpointer 需额外落库 |
| 规模不匹配 | 目标只是一张 3 节点条件循环图 |

DSH 的 `workflow` 工具本身就是成熟的图/流水线编排器（节点 = `agent()`、并行 = `parallel()`、join = 结果归并、条件边 = 返工循环），语义与 LangGraph 一一对应。**结论：复制架构思想，复用原生引擎。**

## 🗂️ 目录结构

```
pipeline-mode/
├── README.md                        # 本文件
├── README.en.md                     # 英文版
├── LICENSE                          # MIT
├── .gitignore
├── docs/
│   └── design.md                    # 完整设计与实现说明
├── preset/                          # ← 安装内容（复制到 DSH 预设根）
│   ├── preset.yml                   #   显示元数据（名称/描述）
│   ├── agent.cordis.yml             #   组成：persona + 全套工具 + 自带 skill 挂载
│   └── skills/pipeline-runner/
│       └── SKILL.md                 #   验证过的 workflow 脚本模板 + 角色定义
└── install.sh                       # 一键安装脚本
```

## 🚀 安装

本发布物是一个 **DSH agent preset**。安装方式是把 `preset/` 目录整体复制到 DSH 的用户预设根目录，无需编译、无依赖（这里"无依赖"指 preset 本身运行时不需要任何 npm 包）。

**默认预设根**：`$HOME/.dsh/.agent-presets/`
（若设置了 `DSH_HOME` 环境变量，则为 `$DSH_HOME/.agent-presets/`）

### 方式一：从发布目录一键脚本

```bash
cd pipeline-mode/            # 进入发布目录
chmod +x install.sh          # 首次需要加执行权限
./install.sh                 # 自动检测根目录，已有则确认覆盖
```

### 方式二：手动复制

```bash
cd pipeline-mode/
mkdir -p ~/.dsh/.agent-presets/
cp -R preset/ ~/.dsh/.agent-presets/pipeline/
```

### 安装后验证

重启 DSH 后，在 GUI 的模式选择器里应能看到 **「流水线模式」**，并附有英文描述。选择该模式新开一个会话，输入一个任务即可开始流水线。

> **注意**：preset 文件名 `pipeline/` 即为 preset id。若预设根下已存在同 id 目录，安装脚本会提示确认覆盖。

## 🎮 使用

1. 在 DSH GUI **新开一个会话**，模式选择 **「流水线模式」**；
2. 直接给任务（如"写一个 Python 快速排序并配测试"）；
   - 若任务有多个相互独立的交付物，可明确说"分别写模块 A、B、C，再写 README 汇总"——此时会自动并行扇出；
   - 简单任务自动走紧凑路径（3 个 agent 即可完成，无并行浪费）。
3. 控制器加载 `pipeline-runner` skill → 调用 `workflow` 工具 → 按用户语言汇报：`status` / `rounds` / 自适应形状（总/并行/依赖步骤数、Reviewer 数）/ 检查摘要；FAIL 时附未解决问题清单与建议。

## ⚙️ 工作原理（图）

```
                        ┌── Executor(独立步骤1) ──┐        ┌── Reviewer A(合规) ──┐
Planner ──┬─(独立步骤≥2)─┤── Executor(独立步骤2) ─├─ join ─┤                      ├─ join → PASS
          │             └── Executor(独立步骤N) ─┘        └── Reviewer B(质量) ──┘   │
          │             └── Executor(依赖步骤,按序)─┘                                  │ FAIL(issues)──┐
          └─(否则)─▶ 单 batch executor 按序执行全部步骤 ─▶ 单综合 Reviewer ─────────────┘              │
                                                                                        ▲               │
                                                                                        └── 新一轮 Planner(最多3轮) ─┘
```

- **Planner** 把任务拆成步骤，并标记 `independent`（仅自包含、无依赖的独立交付物为 true）；
- **硬规则**：`independentSteps >= 2` 才扇出；否则单批执行 + 单 Reviewer；
- **JSON Schema** 强校验每个阶段的输出结构；
- **FAIL 回环**：issues 喂回 Planner，最多 3 轮。

## ✅ 验证记录（真实运行）

| 场景 | 执行形状 | agent 数 | 结果 |
|---|---|---|---|
| 宣传语（无并行需求） | compact：1 batch executor + 1 Reviewer | **3** | PASS 1轮 |
| 3 独立模块 + 依赖 README | 并行扇出（3 并行 + 1 依赖）+ 2 Reviewer | **7** | PASS 1轮 |
| 强制 FAIL → 返工 | 串行 + 回环 | 9 | 返工后 PASS（3轮内） |
| 中文任务 + 语言传递 | 4 步 + 双 Reviewer | 19 | 真实返工后 PASS，输出全中文 |

## 📄 许可

[MIT](LICENSE)
