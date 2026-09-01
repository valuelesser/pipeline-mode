---
name: pipeline-runner
description: Use when running a task through the multi-subagent pipeline (Planner->Executor->Reviewer) or when the user asks to use the 流水线/pipeline mode on a task. Provides the validated ADAPTIVE workflow script template: parallelism only when it pays (>=2 independent steps fan out, with two parallel reviewers), else one compact batch executor and one combined reviewer; JSON-Schema-validated stage outputs; automatic FAIL-rework loop (max 3 rounds); outputs written in the user's language.
---

# pipeline-runner — Planner → Executor → Reviewer ADAPTIVE pipeline

You are the pipeline controller. You **never perform the task yourself**. You push the task through a LangGraph-style graph on the native `workflow` engine that **adapts to whether parallelism pays**:

- **Parallel path** (only when the plan has **≥ 2 independent steps**):
  ```
          ┌── Executor (independent step 1) ──┐        ┌── Reviewer A (compliance) ──┐
  Planner ─┤── Executor (independent step 2) ─├─ join ─┤                              ├─ join → PASS / FAIL
          └── Executor (independent step N) ─┘        └── Reviewer B (quality) ─────┘
          └── Executor (dependent steps, in order) ──┘ (after the fan-out above)
  ```
- **Compact path** (default for simple tasks): **one** batch executor runs all steps in order, then **one** combined reviewer checks compliance + quality. No wasted parallelism.

The Planner marks each step `independent: true` only for self-contained, dependency-free deliverables (e.g. its own file/module); the **script enforces the hard rule `independentSteps >= 2` before any fan-out**, so a simple task never spawns parallel agents.

- On FAIL the issues are fed back verbatim to a new Planner round, then Execute and Review repeat — **automatically**, capped at **3 rounds**.
- **Language**: every stage writes its output in the user's language (passed as `args.language`); internal thinking stays in ENGLISH.

## How to run

1. The TASK = the user's current request (unless they name a different task). Detect the language the user wrote in.
2. Call the `workflow` tool (do NOT execute the task with other tools):
   - `meta`: name = `pipeline-runner`; description = `Planner->Executor->Reviewer adaptive pipeline (parallel only when it pays), auto-rework (max 3 rounds), user-language outputs`; phases = [{title:'Plan'},{title:'Execute'},{title:'Review'}].
   - `args`: `{"task": "<task text>", "language": "<user's language, e.g. Chinese/English>"}`.
   - `script`: paste the template below **verbatim** — do not change roles, schemas, or loop bounds. The task enters through `args.task` and the language through `args.language`.
3. Report the structured result to the user in their language: status (PASS/FAIL/ABORTED), rounds, `adaptive` shape (total/parallel/dependent steps, reviewer count), review summaries; on FAIL also the merged unresolved issues and suggestions.

## Script template (paste verbatim as `script`)

```js
const TASK = args.task
const LANGUAGE = args.language || 'English'
const MAX_ROUNDS = 3

const plannerSchema = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string' },
          input: { type: 'string' },
          output: { type: 'string' },
          acceptance: { type: 'string' },
          independent: { type: 'boolean' }
        },
        required: ['id', 'action', 'output', 'acceptance', 'independent'],
        additionalProperties: false
      }
    }
  },
  required: ['goal', 'steps'],
  additionalProperties: false
}

const stepResultSchema = {
  type: 'object',
  properties: {
    step_id: { type: 'string' },
    status: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    output: { type: 'string' },
    notes: { type: 'string' }
  },
  required: ['step_id', 'status', 'output'],
  additionalProperties: false
}

const batchResultSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: stepResultSchema
    }
  },
  required: ['results'],
  additionalProperties: false
}

const reviewerSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['PASS', 'FAIL'] },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' }
        },
        required: ['location', 'problem', 'suggestion'],
        additionalProperties: false
      }
    }
  },
  required: ['status'],
  additionalProperties: false
}

const THINK = 'When you think, think in ENGLISH, and start with "We need.." to frame the next step.'
const LANG_LINE = 'Write ALL of your output (plan text, step outputs, notes, review summaries, issues) in the user\'s language: ' + LANGUAGE + '. Your internal thinking stays in ENGLISH, starting with "We need..".'

const PLANNER_BRIEF = 'You are stage 1 of the pipeline: Planner. You ONLY plan; you never execute or produce deliverables. ' +
  'Decompose the task into executable steps. For each step define id/action/input/output/acceptance. ' +
  'Mark a step `independent: true` ONLY when it produces its own self-contained deliverable (e.g. its own file/module) AND has NO dependency on any other step\'s output. ' +
  'Concretely: "write module A", "write module B", "write module C" are three independent steps IF each is a separate deliverable with no cross-dependency. ' +
  'A step that reads or merges prior results (e.g. writing a README that documents A, B, C) is NOT independent — set `independent: false` and keep it after its dependencies. ' +
  'Small or trivial steps also stay `independent: false` so they run cheaply. Keep dependent steps ordered after their dependencies. ' +
  'Output JSON per schema: { "goal": string, "steps": [{ "id", "action", "input", "output", "acceptance", "independent" }] }. ' +
  'If a rework issue list is provided, revise the plan ONLY around those issues. ' + THINK + LANG_LINE

const EXECUTOR_STEP_BRIEF = 'You are stage 2 of the pipeline: Executor. You execute ONLY the single step handed to you; ' +
  'you do not modify the plan or add scope. Some steps run in parallel with other steps, others depend on prior work. ' +
  'Produce the step output. ' +
  'Output JSON per schema: { "step_id": string, "status": "done"|"blocked"|"failed", "output": string, "notes": string }. ' +
  'If the step is infeasible, set status to "blocked" or "failed" and explain in notes; never change the plan yourself. ' + THINK + LANG_LINE

const EXECUTOR_BATCH_BRIEF = 'You are stage 2 of the pipeline: Executor running all steps as a SINGLE agent, in order; ' +
  'you do not modify the plan or add scope. ' +
  'For every step produce exactly one result carrying the step\'s id. ' +
  'Output JSON per schema: { "results": [{ "step_id", "status": "done"|"blocked"|"failed", "output", "notes" }] }. ' +
  'If a step is infeasible set its status to "blocked" or "failed" and explain in notes; never change the plan yourself. ' + THINK + LANG_LINE

const REVIEWER_COMBINED_BRIEF = 'You are stage 3 of the pipeline: the single Reviewer (compliance + quality in one agent). ' +
  'Check whether each executed step meets its acceptance criterion from the plan, AND whether the overall result satisfies the task goal, is complete, coherent, and evidence-backed; flag gaps, contradictions, or missing evidence. ' +
  'Output JSON per schema: { "status": "PASS"|"FAIL", "summary": string, "issues": [{ "location", "problem", "suggestion" }] }. ' +
  'PASS => empty issues; FAIL => one issue per problem found, each with a concrete suggestion. You never modify results or redo work. ' + THINK + LANG_LINE

const REVIEWER_COMPLIANCE_BRIEF = 'You are stage 3A of the pipeline: Compliance Reviewer (runs in parallel with another reviewer). ' +
  'Check whether each executed step meets its acceptance criterion from the plan, then give a verdict. ' +
  'Output JSON per schema: { "status": "PASS"|"FAIL", "summary": string, "issues": [{ "location", "problem", "suggestion" }] }. ' +
  'PASS => empty issues; FAIL => one issue per problem found, each with a concrete suggestion. ' +
  'You never modify results or redo work. ' + THINK + LANG_LINE

const REVIEWER_QUALITY_BRIEF = 'You are stage 3B of the pipeline: Requirements & Quality Reviewer (runs in parallel with another reviewer). ' +
  'Check whether the overall result satisfies the task goal, is complete, coherent, and evidence-backed; flag gaps or contradictions. ' +
  'Output JSON per schema: { "status": "PASS"|"FAIL", "summary": string, "issues": [{ "location", "problem", "suggestion" }] }. ' +
  'PASS => empty issues; FAIL => one issue per problem found. You never modify results or redo work. ' + THINK + LANG_LINE

let plan = null
let stepResults = []
let reviews = []
let reworkText = ''
let rounds = 0
let abortReason = null

phase('Plan')
log('task: ' + TASK + ' | language: ' + LANGUAGE)

while (true) {
  rounds += 1

  phase('Plan')
  const plannerPrompt = PLANNER_BRIEF +
    '\n\nTASK:\n' + TASK +
    (reworkText ? '\n\nREWORK ISSUES (revise the plan ONLY around these):\n' + reworkText : '')
  plan = await agent(plannerPrompt, { schema: plannerSchema, label: 'planner-round-' + rounds, phase: 'Plan' })
  if (!plan) { abortReason = 'planner failed (round ' + rounds + ')'; break }

  const independentSteps = plan.steps.filter((s) => s.independent === true)
  const dependentSteps = plan.steps.filter((s) => s.independent !== true)
  const fanOut = independentSteps.length >= 2
  const execResults = []

  // ── Execute: fan-out ONLY when >=2 independent steps; otherwise one batch executor ──
  phase('Execute')
  if (fanOut) {
    log('fan-out: ' + independentSteps.length + ' independent step(s) in parallel')
    await parallel(independentSteps.map((step, i) => async () => {
      const r = await agent(
        EXECUTOR_STEP_BRIEF + '\n\nFULL PLAN:\n' + JSON.stringify(plan) + '\n\nYOUR STEP (runs in parallel with other independent steps):\n' + JSON.stringify(step),
        { schema: stepResultSchema, label: 'executor-par-' + step.id, phase: 'Execute' }
      )
      execResults[i] = r
    }))
    for (let i = 0; i < dependentSteps.length; i++) {
      const r = await agent(
        EXECUTOR_STEP_BRIEF + '\n\nFULL PLAN:\n' + JSON.stringify(plan) +
        '\n\nPRIOR STEP RESULTS (independent + earlier dependent):\n' + JSON.stringify(execResults.filter(Boolean)) +
        '\n\nYOUR DEPENDENT STEP (runs after prior work):\n' + JSON.stringify(dependentSteps[i]),
        { schema: stepResultSchema, label: 'executor-dep-' + dependentSteps[i].id, phase: 'Execute' }
      )
      execResults.push(r)
    }
  } else {
    log('compact: single batch executor (' + plan.steps.length + ' step(s))')
    const batch = await agent(
      EXECUTOR_BATCH_BRIEF + '\n\nFULL PLAN:\n' + JSON.stringify(plan),
      { schema: batchResultSchema, label: 'executor-batch-round-' + rounds, phase: 'Execute' }
    )
    if (batch && Array.isArray(batch.results)) {
      for (const r of batch.results) execResults.push(r)
    }
  }
  stepResults = execResults.filter(Boolean)
  if (stepResults.length === 0) { abortReason = 'all executors failed (round ' + rounds + ')'; break }

  // ── Review: two parallel reviewers when fan-out; one combined reviewer otherwise ──
  phase('Review')
  const reviewResults = []
  if (fanOut) {
    const reviewerBriefs = [REVIEWER_COMPLIANCE_BRIEF, REVIEWER_QUALITY_BRIEF]
    await parallel(reviewerBriefs.map((brief, i) => async () => {
      const r = await agent(
        brief + '\n\nPLAN:\n' + JSON.stringify(plan) + '\n\nEXECUTION RESULTS:\n' + JSON.stringify(stepResults),
        { schema: reviewerSchema, label: 'reviewer-' + (i + 1) + '-round-' + rounds, phase: 'Review' }
      )
      reviewResults[i] = r
    }))
  } else {
    const r = await agent(
      REVIEWER_COMBINED_BRIEF + '\n\nPLAN:\n' + JSON.stringify(plan) + '\n\nEXECUTION RESULTS:\n' + JSON.stringify(stepResults),
      { schema: reviewerSchema, label: 'reviewer-combined-round-' + rounds, phase: 'Review' }
    )
    reviewResults[0] = r
  }
  reviews = reviewResults.filter(Boolean)
  if (reviews.length === 0) { abortReason = 'all reviewers failed (round ' + rounds + ')'; break }

  const roundPassed = reviews.every((r) => r.status === 'PASS')
  if (roundPassed) break
  if (rounds >= MAX_ROUNDS) break

  const issues = []
  const seen = {}
  for (const r of reviews) {
    for (const it of (r.issues || [])) {
      const k = (it.location || '') + '|' + (it.problem || '')
      if (!seen[k]) { seen[k] = true; issues.push(it) }
    }
  }
  reworkText = JSON.stringify(issues)
  log('round ' + rounds + ' FAIL (' + reviews.length + ' reviewer(s)) -> auto rework, round ' + (rounds + 1))
}

if (abortReason) {
  return { status: 'ABORTED', reason: abortReason, rounds }
}

const finalPassed = reviews.length > 0 && reviews.every((r) => r.status === 'PASS')
const allIssues = []
const seenAll = {}
for (const r of reviews) {
  for (const it of (r.issues || [])) {
    const k = (it.location || '') + '|' + (it.problem || '')
    if (!seenAll[k]) { seenAll[k] = true; allIssues.push(it) }
  }
}

const total = plan ? plan.steps.length : 0
const independentCount = plan ? plan.steps.filter((s) => s.independent === true).length : 0
return {
  status: finalPassed ? 'PASS' : 'FAIL',
  rounds,
  adaptive: {
    totalSteps: total,
    parallelSteps: independentCount,
    dependentSteps: total - independentCount,
    parallelReviewers: reviews.length
  },
  reworkAutoLooped: rounds > 1,
  goal: plan ? plan.goal : null,
  reviewSummaries: reviews.map((r) => r.summary || '').filter(Boolean),
  ...(finalPassed ? {} : { unresolvedIssues: allIssues })
}
```

## Stages and strong validation

- **Planner** → `{goal, steps[]}`; each step has id/action/input/output/acceptance plus `independent: boolean` (true only for self-contained, dependency-free deliverables; steps that merge prior results or are trivial stay false). JSON Schema enforces it.
- **Executor**:
  - fan-out path: one agent per independent step (parallel) + dependent steps after (sequential), each `{step_id, status: done|blocked|failed, output, notes}`;
  - compact path: one batch executor returns `{results: [same shape]}` for all steps in order.
- **Reviewers**: fan-out path runs two in parallel (compliance + quality); compact path runs one combined reviewer. All produce `{status: PASS|FAIL, summary, issues[]}`.
- **Join** → PASS only if every reviewer PASSes; FAIL merges and de-duplicates issues by `location|problem`.
- The loop stops on PASS or round 3; if a stage loses all its agents the pipeline returns ABORTED.

## Notes

- Sub-agents are fresh sessions with no shared context — the role briefs in the script are self-contained.
- Do not expand the task scope; Executor only executes planned steps.
- Output language follows `args.language`; thinking stays in ENGLISH (start with "We need..").
