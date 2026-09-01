#!/usr/bin/env node
'use strict'

/**
 * dsh-pipeline-mode — installer for the Pipeline Mode agent preset.
 *
 * Distributes the `preset/` directory of this npm package into DSH's user
 * preset root so it shows up in the mode picker.
 *
 *   dsh-pipeline-mode install      copy preset/ into $DSH_HOME/.agent-presets/pipeline
 *   dsh-pipeline-mode update       same as install, overwrite without prompting
 *   dsh-pipeline-mode uninstall    remove $DSH_HOME/.agent-presets/pipeline
 *   dsh-pipeline-mode verify       static check that the preset is present & well-formed
 *   dsh-pipeline-mode path         print where the preset would be / is installed
 *
 * Options: --force / -y  (skip prompts)
 * No third-party dependencies; Node >= 18.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const PKG_DIR = path.resolve(__dirname, '..')
const PRESET_SRC = path.join(PKG_DIR, 'preset')
const PRESET_ID = 'pipeline'

function presetRoot() {
  const home = os.homedir()
  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh')
  return path.join(dshHome, '.agent-presets')
}

function destDir() {
  return path.join(presetRoot(), PRESET_ID)
}

function homeDisplay(p) {
  return p.replace(os.homedir(), '~')
}

function log(...a) { console.log(...a) }
function err(...a) { console.error(...a) }

async function confirm(promptText) {
  if (process.argv.includes('--force') || process.argv.includes('-y')) return true
  return new Promise((resolve) => {
    process.stdout.write(`${promptText} [y/N] `)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.once('data', (data) => {
      process.stdin.pause()
      const answer = String(data).trim().toLowerCase()
      resolve(answer === 'y' || answer === 'yes')
    })
  })
}

function checkSource() {
  const required = [
    path.join(PRESET_SRC, 'preset.yml'),
    path.join(PRESET_SRC, 'agent.cordis.yml'),
    path.join(PRESET_SRC, 'skills', 'pipeline-runner', 'SKILL.md'),
  ]
  const missing = required.filter((f) => !fs.existsSync(f))
  if (missing.length > 0) {
    err(`错误：发布目录不完整，缺少文件:\n  ${missing.map(homeDisplay).join('\n  ')}`)
    err(`请从完整发布包运行（应包含 preset/ 目录）。`)
    process.exit(1)
  }
}

async function install({ overwrite }) {
  checkSource()
  const dest = destDir()
  if (fs.existsSync(dest) && !overwrite) {
    const ok = await confirm(`目标目录已存在: ${homeDisplay(dest)}\n覆盖其中的文件？`)
    if (!ok) { log('已取消。'); return 0 }
  }
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(PRESET_SRC, dest, { recursive: true })
  log(`✅ 已安装到 ${homeDisplay(dest)}`)
  log('现在可以在 DSH GUI 中新建会话，模式选择「流水线模式 / Pipeline Mode」。')
  log('（若 DSH 已在运行，需重启后才会扫描到新预设。）')
  return 0
}

async function uninstall() {
  const dest = destDir()
  if (!fs.existsSync(dest)) {
    log(`未安装（不存在 ${homeDisplay(dest)}）。`)
    return 0
  }
  const ok = await confirm(`确认删除 ${homeDisplay(dest)} ？`)
  if (!ok) { log('已取消。'); return 0 }
  fs.rmSync(dest, { recursive: true, force: true })
  log(`🗑️  已卸载 ${homeDisplay(dest)}`)
  return 0
}

function verify() {
  const dest = destDir()
  const checks = [
    ['preset.yml 存在', fs.existsSync(path.join(dest, 'preset.yml'))],
    ['agent.cordis.yml 存在', fs.existsSync(path.join(dest, 'agent.cordis.yml'))],
    ['SKILL.md 存在', fs.existsSync(path.join(dest, 'skills', 'pipeline-runner', 'SKILL.md'))],
  ]
  if (fs.existsSync(path.join(dest, 'preset.yml'))) {
    const raw = fs.readFileSync(path.join(dest, 'preset.yml'), 'utf8')
    checks.push(['preset.yml 含 name', /name\s*:/.test(raw)])
    checks.push(['preset.yml 含 description', /description\s*:/.test(raw)])
  }
  if (fs.existsSync(path.join(dest, 'agent.cordis.yml'))) {
    const raw = fs.readFileSync(path.join(dest, 'agent.cordis.yml'), 'utf8')
    checks.push(['含 persona 行', /- id: persona/.test(raw)])
    checks.push(['含 customSkillDirs', /customSkillDirs/.test(raw)])
  }
  if (fs.existsSync(path.join(dest, 'skills', 'pipeline-runner', 'SKILL.md'))) {
    const raw = fs.readFileSync(path.join(dest, 'skills', 'pipeline-runner', 'SKILL.md'), 'utf8')
    checks.push(['含自适应硬规则 fanOut', /const fanOut = independentSteps\.length >= 2/.test(raw)])
    checks.push(['含语言传递 args.language', /args\.language/.test(raw)])
    checks.push(['含思考协议 We need..', /We need\.\./.test(raw)])
  }
  let allOk = true
  for (const [label, ok] of checks) {
    log(`${ok ? '  ✓' : '  ✗'} ${label}`)
    if (!ok) allOk = false
  }
  if (!allOk) {
    err(`\n❌ 静态校验未通过。预设可能不完整，请重新 ${PKG_DIR.includes('node_modules') ? '执行安装' : '安装'}。`)
    process.exit(1)
  }
  log(`\n✅ 静态校验通过：${homeDisplay(dest)}`)
  log('（说明：这是文件级校验；最终挂载校验由 DSH 运行时在会话启动时执行。）')
  return 0
}

async function main() {
  const cmd = process.argv[2] || 'help'
  switch (cmd) {
    case 'install':
      return install({ overwrite: false })
    case 'update':
      return install({ overwrite: true })
    case 'uninstall':
      return uninstall()
    case 'verify':
      return verify()
    case 'path':
      log(homeDisplay(destDir()))
      return 0
    case 'help':
    case '--help':
    case '-h':
      log('dsh-pipeline-mode — Pipeline Mode preset installer')
      log('')
      log('用法:')
      log('  dsh-pipeline-mode install     安装 preset 到 DSH 用户预设根')
      log('  dsh-pipeline-mode update      覆盖安装（不提示）')
      log('  dsh-pipeline-mode uninstall   卸载')
      log('  dsh-pipeline-mode verify      校验已安装的 preset 文件')
      log('  dsh-pipeline-mode path        显示安装目标路径')
      log('')
      log('选项:')
      log('  --force / -y   跳过确认提示')
      return 0
    default:
      err(`未知命令: ${cmd}`)
      err('运行 dsh-pipeline-mode help 查看用法。')
      process.exit(1)
  }
}

main().then((code) => process.exitCode = code ?? 0)
