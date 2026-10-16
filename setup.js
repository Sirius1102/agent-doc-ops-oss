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
//   node setup.js --with-system-deps <csv|all> [--include-vc]  # 显式 opt-in 才装系统依赖
//      （委托 install-system-deps.js；获取参数经 SYSDEPS_* 环境变量给；VC++ 另需 --include-vc 双重显式）
//
// 前提：机器已有 Node（本脚本本身用 Node 跑，Node 缺失时这条命令根本无法启动——
// 安装说明里写明 Node ≥ 22.19，缺 Node 时先装 Node 再回来）。
// 系统侧可选依赖（Tesseract/Poppler/Pandoc/OfficeCLI/字体）不在这里硬装——
// 平台差异与授权差异太大，交给最后的 doctor 明确报告缺什么、哪些命令不可用。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// 路径脱敏（发布前 P0-1）：输出里的人机路径折叠成占位（本地仍可按占位找到，贴到公开 issue 不泄用户名）。
// 规则：USERPROFILE→%USERPROFILE%、LOCALAPPDATA→%LOCALAPPDATA%、本仓→<REPO>（与 char-baseline 同一套）。
function foldPath(p) {
  // 最长前缀胜出（LOCALAPPDATA 嵌在 USERPROFILE 里时取更具体的那个）。
  let s = String(p);
  const cands = [
    [ROOT, '<REPO>'],
    [process.env.LOCALAPPDATA || '', '%LOCALAPPDATA%'],
    [process.env.ProgramFiles || 'C:\\Program Files', '%ProgramFiles%'],
    [process.env.SystemRoot || process.env.windir || 'C:\\Windows', '%WINDIR%'],
    [process.env.USERPROFILE || process.env.HOME || '', '%USERPROFILE%'],
  ].filter(([c]) => c && (s === c || s.startsWith(c + path.sep)));
  if (cands.length) { cands.sort((a, b) => b[0].length - a[0].length); s = cands[0][1] + s.slice(cands[0][0].length); }
  return s;
}

function detectSkillDirs() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return [];
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

function pruneBackups(dir, base) {
  // .bak 保留策略：只留最近 3 个旧备份，多出的在本次成功安装后清理（重复执行不无限堆）。
  let olds = [];
  try { olds = fs.readdirSync(dir).filter((n) => n.startsWith(base + '.bak-')).sort(); } catch { return; }
  while (olds.length > 3) { const victim = olds.shift(); try { fs.rmSync(path.join(dir, victim), { recursive: true, force: true }); } catch { break; } }
}

// 拷贝完整性：临时目录里的相对路径集合必须与源逐项一致（只验 SKILL.md 等于"装了个壳就敢换名"）。
function assertCopied(src, tmp) {
  const list = (d, base) => {
    const out = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(base, p);
      if (e.isDirectory()) out.push(...list(p, base));
      else out.push(rel);
    }
    return out.sort();
  };
  const a = list(src, src), b = list(tmp, tmp);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new Error(`复制不完整：源 ${a.length} 件、临时目录 ${b.length} 件`);
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
    assertCopied(src, tmp);
    if (backedUp) fs.renameSync(dst, backedUp);
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(tmp, dst);
    pruneBackups(path.dirname(dst), path.basename(dst));
    return { ok: true, dir: dst, backedUp };
  } catch (e) {
    // 回滚：换名失败或复制失败时恢复备份
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { if (backedUp && !fs.existsSync(dst) && fs.existsSync(backedUp)) fs.renameSync(backedUp, dst); } catch {}
    return { ok: false, dir, error: String(e.message || e).slice(0, 160) + (backedUp ? '（旧技能卡保留于 ' + path.basename(backedUp) + '）' : '') };
  }
}

function main(argv) {
  const PKG_VERSION = (() => { try { return require('./package.json').version; } catch { return 'unknown'; } })();
  if (argv.includes('--help')) { console.log(JSON.stringify({ ok: true, op: 'setup', usage: 'node setup.js [--skill-dir <目录1> --skill-dir <目录2>] [--no-deps] [--no-doctor] [--list] [--with-system-deps <csv|all>] [--include-vc]' })); return; }
  if (argv.includes('--version')) { console.log(JSON.stringify({ ok: true, op: 'setup', version: PKG_VERSION })); return; }
  const a = { dirs: [], noDeps: false, noDoctor: false, list: false, sysDeps: null, includeVc: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--skill-dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.log(JSON.stringify({ ok: false, op: 'setup', code: 'invalid-args', error: '--skill-dir 缺值', next: '用 --skill-dir <目录> 指定技能安装目录' }));
        process.exitCode = 1;
        return;
      }
      a.dirs.push(value);
      i++;
    }
    else if (x === '--no-deps') a.noDeps = true;
    else if (x === '--no-doctor') a.noDoctor = true;
    else if (x === '--list') a.list = true;
    else if (x === '--include-vc') a.includeVc = true;
    else if (x === '--with-system-deps') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.log(JSON.stringify({ ok: false, op: 'setup', code: 'invalid-args', error: '--with-system-deps 缺值', next: '用 --with-system-deps <vc,tesseract,poppler,pandoc,officecli|all>（系统依赖默认不装，这是显式 opt-in）' }));
        process.exitCode = 1;
        return;
      }
      a.sysDeps = value;
      i++;
    }
    else {
      console.log(JSON.stringify({ ok: false, op: 'setup', code: 'invalid-args', error: `未知参数：${x}`, next: '检查 setup.js 参数拼写' }));
      process.exitCode = 1;
      return;
    }
  }
  const steps = [];
  const detected = detectSkillDirs().filter((d) => fs.existsSync(d));

  if (a.list) {
    console.log(JSON.stringify({ ok: true, op: 'setup-list', detectedSkillDirs: detected.map(foldPath), note: '用 --skill-dir 显式指定，或直接跑 node setup.js 装进第一个已存在的目录' }));
    return;
  }

  // 0) Node 版本前置拦截（旧 Node 不浪费一次 npm install）
  const [nodeMaj, nodeMin] = process.versions.node.split('.').map(Number);
  if (!(nodeMaj > 22 || (nodeMaj === 22 && nodeMin >= 19))) {
    console.log(JSON.stringify({ ok: false, op: 'setup', code: 'node-too-old', error: `Node 版本过低：${process.version}（需 >=22.19.0）`, next: '先升级 Node 再跑 setup.js' }));
    process.exit(1);
  }
  // 0.5) 非 Windows 显式声明（VC++ 运行库探针必 FAIL 属预期，不阻断安装）
  if (process.platform !== 'win32') steps.push({ step: 'platform', ok: true, detail: `WARN 非 Windows（${process.platform}）：VC++ 运行库探针必 FAIL 属预期；依赖照装，功能仅在 Windows 实测` });

  // 1) 依赖
  if (!a.noDeps) {
    const p = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { encoding: 'utf8', cwd: ROOT, shell: process.platform === 'win32', timeout: 600000 });
    steps.push({ step: 'npm install', ok: p.status === 0, detail: p.status === 0 ? '依赖装齐（kit/pdf-lib/fontkit）' : String(p.stderr || p.stdout).slice(0, 200) });
    if (p.status !== 0) { console.log(JSON.stringify({ ok: false, op: 'setup', steps, next: 'npm install 失败——先核网络与 Node 版本（需 ≥22.19）', exitCode: 1 }, null, 1)); process.exit(1); }
  } else {
    steps.push({ step: 'npm install', ok: true, detail: '按 --no-deps 跳过' });
  }

  // 2) 技能卡（显式目录优先，多目录都装；没显式就装进第一个探测到的，其余明示为 skipped）
  const targets = a.dirs.length ? a.dirs : (detected.length ? [detected[0]] : []);
  const skippedSkillDirs = a.dirs.length ? [] : detected.slice(1);
  if (!targets.length) {
    steps.push({ step: 'skill install', ok: false, detail: '没探测到任何 agent 技能目录，也没给 --skill-dir——技能卡未装（装置本身已可用，用 node dockit.js 调用）' });
  } else {
    for (const dir of targets) {
      const r = installSkill(dir);
      steps.push({ step: 'skill install → ' + foldPath(dir), ok: r.ok, detail: r.ok ? (r.backedUp ? '已装（旧卡备份于 ' + path.basename(r.backedUp) + '）' : '已装') : r.error });
    }
  }

  // 2.5) 系统依赖（显式 opt-in 才跑：委托 install-system-deps.js；获取参数经 SYSDEPS_* 环境变量给）
  if (a.sysDeps) {
    const sysArgs = [path.join(ROOT, 'install-system-deps.js'), '--components', a.sysDeps, '--yes'];
    if (a.includeVc) sysArgs.push('--include-vc');
    const s = spawnSync(process.execPath, sysArgs, { encoding: 'utf8', cwd: ROOT, timeout: 1800000 });
    // 稳定契约：子进程的交互输出（winget/安装包界面经 pipe 混进 stdout）不得误判——从末尾往前找
    // 第一个 op 标记为 install-system-deps 的 JSON 行，而不是无脑取末行。
    let sj = null;
    try {
      const lines = (String(s.stdout || '') + '\n' + String(s.stderr || '')).split(/\r?\n/).filter(Boolean);
      for (let li = lines.length - 1; li >= 0; li--) {
        try { const cand = JSON.parse(lines[li]); if (cand && cand.op === 'install-system-deps') { sj = cand; break; } } catch {}
      }
    } catch {}
    steps.push({ step: 'system deps → ' + a.sysDeps, ok: !!(sj && sj.ok), detail: sj ? (sj.ok ? '系统依赖 assisted 安装完成（doctor 验收见下一步）' : `拒绝/失败：${sj.code || ''} ${sj.error || ''}`.slice(0, 160)) : '子进程没出 JSON（异常）' });
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
  console.log(JSON.stringify({ ok, op: 'setup', steps, skippedSkillDirs: skippedSkillDirs.map(foldPath), note: '系统侧可选依赖（Tesseract/Poppler/Pandoc/OfficeCLI）按 doctor 的 WARN 逐条指路安装；OCR/渲染等命令缺件时回 unavailable 不误出半成品' }, null, 1));
  process.exit(ok ? 0 : 1);
}

main(process.argv.slice(2));
