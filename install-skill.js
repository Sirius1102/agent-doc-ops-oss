#!/usr/bin/env node
'use strict';
// install-skill.js — 把本仓 skills/agent-doc-ops/ 装进 agent 的技能目录（一条命令）。
// 只写技能目录；已存在同名技能先备份再覆盖；--list 只探测不写。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'skills', 'agent-doc-ops');
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

function candidateDirs() {
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

function pruneBackups(dir, base) {
  // .bak 保留策略：只留最近 3 个旧备份，多出的在本次成功安装后清理（重复执行不无限堆）。
  let olds = [];
  try { olds = fs.readdirSync(dir).filter((n) => n.startsWith(base + '.bak-')).sort(); } catch { return; }
  while (olds.length > 3) { const victim = olds.shift(); try { fs.rmSync(path.join(dir, victim), { recursive: true, force: true }); } catch { break; } }
}

function main(argv) {
  const PKG_VERSION = (() => { try { return require('./package.json').version; } catch { return 'unknown'; } })();
  if (argv.includes('--help')) { console.log(JSON.stringify({ ok: true, op: 'install-skill', usage: 'node install-skill.js [--dir <目录>] [--list]' })); return; }
  if (argv.includes('--version')) { console.log(JSON.stringify({ ok: true, op: 'install-skill', version: PKG_VERSION })); return; }
  const a = { list: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') a.list = true;
    else if (argv[i] === '--dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error(JSON.stringify({ ok: false, code: 'invalid-args', error: '--dir 缺值', next: '用 --dir <目录> 指定技能安装目录' }));
        process.exitCode = 1;
        return;
      }
      a.dir = value;
      i++;
    } else {
      console.error(JSON.stringify({ ok: false, code: 'invalid-args', error: `未知参数：${argv[i]}`, next: '检查 install-skill.js 参数拼写' }));
      process.exitCode = 1;
      return;
    }
  }
  if (!fs.existsSync(path.join(SRC, 'SKILL.md'))) {
    console.error(JSON.stringify({ ok: false, code: 'missing-source', next: `确认 ${SRC} 存在 SKILL.md` }));
    process.exit(1);
  }
  const cands = a.dir ? [a.dir] : candidateDirs().filter((d) => fs.existsSync(d));
  if (a.list) { console.log(JSON.stringify({ ok: true, detected: cands.map(foldPath), source: foldPath(SRC) })); return; }
  if (!cands.length) {
    console.error(JSON.stringify({ ok: false, code: 'no-skills-dir', next: '用 --dir 显式指定技能目录（如 %USERPROFILE%\\.codex\\skills）' }));
    process.exit(1);
  }
  const dst = path.join(cands[0], 'agent-doc-ops');
  const skippedDirs = cands.slice(1);
  let backedUp = null;
  if (fs.existsSync(dst)) backedUp = dst + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  // 原子安装（与 setup.js 同形状）：先装进临时目录验 SKILL.md，再换名上位；失败回滚并清临时目录。
  const tmp = dst + '.new-' + new Date().toISOString().replace(/[:.]/g, '-');
  try {
    copyDir(SRC, tmp);
    if (!fs.existsSync(path.join(tmp, 'SKILL.md'))) throw new Error('临时目录里没有 SKILL.md（复制不完整）');
    assertCopied(SRC, tmp);
    if (backedUp) fs.renameSync(dst, backedUp);
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(tmp, dst);
    pruneBackups(path.dirname(dst), path.basename(dst));
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { if (backedUp && !fs.existsSync(dst) && fs.existsSync(backedUp)) fs.renameSync(backedUp, dst); } catch {}
    console.error(JSON.stringify({ ok: false, code: 'install-failed', error: String(e.message || e).slice(0, 160), next: '看 error 原文；旧技能卡保留于 ' + (backedUp ? path.basename(backedUp) : '（无备份）') }));
    process.exit(1);
  }
  const result = { ok: true, installed: foldPath(dst), backedUp: backedUp ? foldPath(backedUp) : null, skippedDirs: skippedDirs.map(foldPath), verify: `node ${foldPath(process.argv[1])} --list` };
  console.log(JSON.stringify(result));
}

main(process.argv.slice(2));
