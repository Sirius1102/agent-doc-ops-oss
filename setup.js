#!/usr/bin/env node
'use strict';
// setup.js — 一条命令启动安装流程：检测环境 → 装依赖 → 装技能卡（可多目录）→ doctor 验收。
//
// 用法：
//   node setup.js                # 全流程：npm install + 技能卡（自动探测目录）+ doctor
//   node setup.js --skill-dir <目录1> --skill-dir <目录2>   # 装进多个 agent 技能目录
//   node setup.js --no-deps      # 跳过 npm install（已装过依赖时）
//   node setup.js --no-doctor    # 跳过最后的 doctor 验收
//   node setup.js --list         # 只列出探测到的 agent 技能目录
//
// 前提：机器已有 Node（本脚本本身用 Node 跑，Node 缺失时这条命令根本无法启动——
// 安装说明里写明 Node ≥ 22.19，缺 Node 时先装 Node 再回来）。
// 系统侧可选依赖（Tesseract/Poppler/Pandoc/OfficeCLI/字体）不在这里硬装——
// 平台差异与授权差异太大，交给最后的 doctor 明确报告缺什么、哪些命令不可用。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function detectSkillDirs() {
  const home = process.env.USERPROFILE || process.env.HOME;
  return [
    path.join(home, '.codex', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.dsh', 'skills'),
    path.join(home, '.opencode', 'skills'),
    path.join(home, '.agent', 'skills'),
  ];
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function installSkill(dir) {
  const src = path.join(ROOT, 'skills', 'agent-doc-ops');
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) return { ok: false, dir, error: '本仓 skills/agent-doc-ops/SKILL.md 缺失' };
  const dst = path.join(dir, 'agent-doc-ops');
  let backedUp = null;
  if (fs.existsSync(dst)) backedUp = dst + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  // 先装到临时目录验完整，再原子替换原目录；复制中途失败恢复备份（P2 审查项：直接复制失败会留下半成品）。
  const tmp = dst + '.new-' + new Date().toISOString().replace(/[:.]/g, '-');
  try {
    copyDir(src, tmp);
    if (!fs.existsSync(path.join(tmp, 'SKILL.md'))) throw new Error('临时目录里没有 SKILL.md（复制不完整）');
    if (backedUp) fs.renameSync(dst, backedUp);
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(tmp, dst);
    return { ok: true, dir: dst, backedUp };
  } catch (e) {
    // 回滚：换名失败或复制失败时恢复备份
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { if (backedUp && !fs.existsSync(dst) && fs.existsSync(backedUp)) fs.renameSync(backedUp, dst); } catch {}
    return { ok: false, dir, error: String(e.message || e).slice(0, 160) + (backedUp ? '（旧技能卡保留于 ' + path.basename(backedUp) + '）' : '') };
  }
}

function main(argv) {
  const a = { dirs: [], noDeps: false, noDoctor: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--skill-dir') a.dirs.push(argv[++i]);
    else if (x === '--no-deps') a.noDeps = true;
    else if (x === '--no-doctor') a.noDoctor = true;
    else if (x === '--list') a.list = true;
  }
  const steps = [];
  const detected = detectSkillDirs().filter((d) => fs.existsSync(d));

  if (a.list) {
    console.log(JSON.stringify({ ok: true, op: 'setup-list', detectedSkillDirs: detected, note: '用 --skill-dir 显式指定，或直接跑 node setup.js 装进第一个已存在的目录' }));
    return;
  }

  // 1) 依赖
  if (!a.noDeps) {
    const p = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { encoding: 'utf8', cwd: ROOT, shell: process.platform === 'win32', timeout: 600000 });
    steps.push({ step: 'npm install', ok: p.status === 0, detail: p.status === 0 ? '依赖装齐（kit/pdf-lib/fontkit）' : String(p.stderr || p.stdout).slice(0, 200) });
    if (p.status !== 0) { console.log(JSON.stringify({ ok: false, op: 'setup', steps, next: 'npm install 失败——先核网络与 Node 版本（需 ≥22.19）', exitCode: 1 }, null, 1)); process.exit(1); }
  } else {
    steps.push({ step: 'npm install', ok: true, detail: '按 --no-deps 跳过' });
  }

  // 2) 技能卡（显式目录优先，多目录都装；没显式就装进第一个探测到的）
  const targets = a.dirs.length ? a.dirs : (detected.length ? [detected[0]] : []);
  if (!targets.length) {
    steps.push({ step: 'skill install', ok: false, detail: '没探测到任何 agent 技能目录，也没给 --skill-dir——技能卡未装（装置本身已可用，用 node dockit.js 调用）' });
  } else {
    for (const dir of targets) {
      const r = installSkill(dir);
      steps.push({ step: 'skill install → ' + dir, ok: r.ok, detail: r.ok ? (r.backedUp ? '已装（旧卡备份于 ' + path.basename(r.backedUp) + '）' : '已装') : r.error });
    }
  }

  // 3) doctor 验收
  if (!a.noDoctor) {
    const d = spawnSync(process.execPath, [path.join(ROOT, 'dockit.js'), 'doctor'], { encoding: 'utf8', cwd: ROOT, timeout: 180000 });
    let dj = null; try { dj = JSON.parse(String(d.stdout).split(/\r?\n/).filter(Boolean).pop()); } catch {}
    const fails = dj && Array.isArray(dj.checks) ? dj.checks.filter((c) => c.startsWith('FAIL')) : [];
    const warns = dj && Array.isArray(dj.checks) ? dj.checks.filter((c) => c.startsWith('WARN')) : [];
    steps.push({ step: 'doctor', ok: dj && dj.ok === true, detail: `ok=${dj && dj.ok} FAIL=${fails.length} WARN=${warns.length}` + (fails.length ? ' | ' + fails.slice(0, 3).join(' | ') : '') + (warns.length ? ' | 可选依赖缺失（WARN）：' + warns.slice(0, 3).join(' | ') : '') });
  }

  const ok = steps.every((s) => s.ok);
  console.log(JSON.stringify({ ok, op: 'setup', steps, note: '系统侧可选依赖（Tesseract/Poppler/Pandoc/OfficeCLI）按 doctor 的 WARN 逐条指路安装；OCR/渲染等命令缺件时回 unavailable 不误出半成品' }, null, 1));
  process.exit(ok ? 0 : 1);
}

main(process.argv.slice(2));
