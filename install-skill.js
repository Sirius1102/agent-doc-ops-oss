#!/usr/bin/env node
'use strict';
// install-skill.js — 把本仓 skills/agent-doc-ops/ 装进 agent 的技能目录（一条命令）。
// 只写技能目录；已存在同名技能先备份再覆盖；--list 只探测不写。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'skills', 'agent-doc-ops');

function candidateDirs() {
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

function main(argv) {
  const a = { list: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') a.list = true;
    else if (argv[i] === '--dir') a.dir = argv[++i];
  }
  if (!fs.existsSync(path.join(SRC, 'SKILL.md'))) {
    console.error(JSON.stringify({ ok: false, code: 'missing-source', next: `确认 ${SRC} 存在 SKILL.md` }));
    process.exit(1);
  }
  const cands = a.dir ? [a.dir] : candidateDirs().filter((d) => fs.existsSync(d));
  if (a.list) { console.log(JSON.stringify({ ok: true, detected: cands, source: SRC })); return; }
  if (!cands.length) {
    console.error(JSON.stringify({ ok: false, code: 'no-skills-dir', next: '用 --dir 显式指定技能目录（如 %USERPROFILE%\\.codex\\skills）' }));
    process.exit(1);
  }
  const dst = path.join(cands[0], 'agent-doc-ops');
  let backedUp = null;
  if (fs.existsSync(dst)) {
    const bak = dst + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(dst, bak);
    backedUp = bak;
  }
  copyDir(SRC, dst);
  const result = { ok: true, installed: dst, backedUp, verify: `node ${process.argv[1]} --list` };
  console.log(JSON.stringify(result));
}

main(process.argv.slice(2));
