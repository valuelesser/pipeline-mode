# Pipeline Mode

**English | [中文](README.md)**

An **Agent Preset** for [DSH](https://github.com/deepseek-ai/dsh) (DeepSeek Harness): a Planner → Executor → Reviewer multi-subagent pipeline implemented as a **LangGraph-style adaptive conditional graph**, running on DSH's native `workflow` engine.

> **Preset vs Plugin**: This is an **agent preset** (YAML composition + bundled skill), not an npm plugin package. DSH presets are shared by sharing a directory — copy it into the user preset root and you're done. No build step, no dependencies.

---

## ✨ Features

- **Planner → Executor → Reviewer** three stages, each a subagent; every output is **JSON Schema validated** (malformed results are rejected outright — more reliable than XML handoff blocks).
- **Reviewer FAIL → automatic rework**: issues are de-duplicated and fed back verbatim to the next Planner round; up to **3 rounds**, then stop.
- **Adaptive parallelism**: fan-out with two parallel Reviewers **only when ≥ 2 independent steps** exist; otherwise a **compact** path (1 batch executor + 1 combined reviewer) runs — no wasted agents on simple tasks.
- **User-language outputs**: the user's language is passed via `args.language`; plan, execution, review, and issues are all written in that language.
- **English thinking protocol**: internal reasoning stays in English and starts with `"We need.."` — decoupled from output language.
- **Zero external dependencies**: reuses DSH's native `workflow` engine; model routing works out of the box.

## 🧠 Why not real LangGraph.js

| Obstacle | Explanation |
|---|---|
| Dependency install | Presets are YAML compositions — can't `npm install`. Running LangGraph.js requires building a Host plugin into the Profile/deployment. |
| Model routing | LangGraph ships its own ChatModel interface; adapting it to DSH's internal `dsh-llm` is a significant integration effort. |
| Persistence | LangGraph's checkpointer requires its own store layer. |
| Overkill | The target is a single 3-node conditional loop — not worth importing an entire framework. |

DSH's `workflow` tool **is** a mature graph/pipeline orchestrator (nodes = `agent()`, parallel = `parallel()`, join = result merge, conditional edges = rework loop) — semantics match LangGraph one-to-one. **Take the architecture; reuse the native engine.**

## 🗂️ Repository structure

```
pipeline-mode/
├── README.md                        # This file
├── README.en.md                     # English version
├── LICENSE                          # MIT
├── .gitignore
├── docs/
│   └── design.md                    # Full design & implementation document
├── preset/                          # ← Installable content
│   ├── preset.yml                   #   Display metadata (name / description)
│   ├── agent.cordis.yml             #   Composition: persona + full toolset + bundled skill
│   └── skills/pipeline-runner/
│       └── SKILL.md                 #   Validated workflow script template + role briefs
└── install.sh                       # One-click installer
```

## 🚀 Installation

This release is a **DSH agent preset**. Install it by copying the `preset/` directory into DSH's user preset root. No build step, no dependencies (the preset itself needs no npm packages at runtime).

**Default preset root**: `$HOME/.dsh/.agent-presets/`
(Override with the `DSH_HOME` environment variable: `$DSH_HOME/.agent-presets/`)

### Option 0: npm (published as an npm package)

```bash
npm i -g dsh-pipeline-mode          # installs the preset/ dir + CLI
dsh-pipeline-mode install           # copies the preset into DSH's preset root
```

Or run once without a global install:

```bash
npx dsh-pipeline-mode install
```

CLI subcommands:

| Command | Action |
|---|---|
| `dsh-pipeline-mode install` | Install (prompts before overwriting an existing install) |
| `dsh-pipeline-mode update` | Overwrite-install (no prompt) |
| `dsh-pipeline-mode uninstall` | Uninstall |
| `dsh-pipeline-mode verify` | Static validation of the installed preset files |
| `dsh-pipeline-mode path` | Print the install target path |

`--force` / `-y` skips all confirmations. To upgrade: `npm i -g dsh-pipeline-mode@latest && dsh-pipeline-mode update`.

### Option A: one-click script from the release directory

```bash
cd pipeline-mode/
chmod +x install.sh        # first time only
./install.sh               # detects root, prompts if id already exists
```

### Option B: Manual copy

```bash
cd pipeline-mode/
mkdir -p ~/.dsh/.agent-presets/
cp -R preset/ ~/.dsh/.agent-presets/pipeline/
```

### Verify installation

After restarting DSH, the mode picker in the GUI should show **「流水线模式 / Pipeline Mode」**. Select it, open a new session, and give it a task to start the pipeline.

> **Note**: The directory name `pipeline/` is the preset id. If a directory with that id already exists, the installer will prompt before overwriting.

## 🎮 Usage

1. Open a **new session** in the DSH GUI; select the mode **「流水线模式 / Pipeline Mode」**.
2. Give it a task (e.g. *"write a Python quicksort with tests"*).
   - If the task has multiple independent deliverables, say so explicitly (e.g. *"write module A, module B, module C separately, then write a README"*); the pipeline will automatically fan out independent steps.
   - Simple tasks use the compact path automatically (3 agents total, no wasted parallelism).
3. The controller loads the `pipeline-runner` skill → calls the `workflow` tool → reports the result in your language: `status` / `rounds` / adaptive shape (total / parallel / dependent step counts, reviewer count) / review summary; on FAIL also unresolved issues and suggestions.

## ⚙️ How it works (graph)

```
                        ┌── Executor(step 1) ──┐        ┌── Reviewer A (compliance) ──┐
Planner ──┬─(≥2 indep.)─┤── Executor(step 2) ─├─ join ─┤                              ├─ join → PASS
          │             └── Executor(step N) ─┘        └── Reviewer B (quality) ─────┘   │
          │             └── Executor(dependent) ──┘                                       │ FAIL(issues)──┐
          └─(else)─▶ single batch executor, all steps ─▶ single combined Reviewer ───────┘              │
                                                                                         ▲               │
                                                                                         └── next Planner (max 3) ─┘
```

- **Planner** decomposes the task and marks each step `independent: true` only when it produces a self-contained, dependency-free deliverable.
- **Hard rule**: fan-out fires **only when `independentSteps.length ≥ 2`**; otherwise the compact path runs.
- **JSON Schema** validates every stage output.
- **FAIL loop**: issues feed back to Planner; loop stops on PASS or round 3.

## ✅ Validation (real runs)

| Scenario | Execution shape | Agents | Result |
|---|---|---|---|
| Slogan (no parallelism) | compact: 1 batch executor + 1 Reviewer | **3** | PASS (1 round) |
| 3 independent modules + README | fan-out (3 parallel + 1 dependent) + 2 Reviewers | **7** | PASS (1 round) |
| Forced FAIL → rework | serial + loop | 9 | PASS after rework (≤ 3 rounds) |
| Chinese task + language passthrough | 4 steps + dual Reviewer | 19 | PASS after real rework; output all Chinese |

## 📄 License

[MIT](LICENSE)
