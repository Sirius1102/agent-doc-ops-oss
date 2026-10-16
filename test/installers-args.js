#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dockit-installer-args-'));

function run(script, args, envExtra) {
  const p = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: Object.assign({}, process.env, { USERPROFILE: cwd, HOME: cwd }, envExtra),
  });
  return { exit: p.status, output: p.stdout || p.stderr || '' };
}
const j = (r) => JSON.parse(r.output);
// 把输出里的占位折回真实路径再做文件断言（输出本身必须保持占位，见 T15–T18）
const expand = (s) => String(s)
  .replace(/^%USERPROFILE%/, cwd)
  .replace(/^%LOCALAPPDATA%/, process.env.LOCALAPPDATA || '')
  .replace(/^<REPO>/, root);
const ABS_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:^|[\s"'(])\/(?:home|Users|tmp|var|opt|etc|usr|mnt|root)\/)/;

try {
  const setup = run('setup.js', ['--no-deps', '--skill-dir', '--no-doctor']);
  const setupJson = JSON.parse(setup.output);
  assert.equal(setup.exit, 1);
  assert.equal(setupJson.code, 'invalid-args');
  assert.equal(fs.existsSync(path.join(cwd, '--no-doctor')), false);

  const skill = run('install-skill.js', ['--dir', '--list']);
  const skillJson = JSON.parse(skill.output);
  assert.equal(skill.exit, 1);
  assert.equal(skillJson.code, 'invalid-args');
  assert.equal(fs.existsSync(path.join(cwd, '--list')), false);

  const fonts = run('install-fonts.js', ['--source', '--check']);
  const fontsJson = JSON.parse(fonts.output);
  assert.equal(fonts.exit, 1);
  assert.equal(fontsJson.code, 'invalid-args');

  // T4：HOME/USERPROFILE 全空 → no-skills-dir（不是崩栈）
  const nohome = run('install-skill.js', [], { USERPROFILE: '', HOME: '' });
  const nohomeJson = j(nohome);
  assert.equal(nohome.exit, 1);
  assert.equal(nohomeJson.code, 'no-skills-dir');

  // T5：--dir 隔离安装＋二次覆盖走备份（原子：旧件先进 .bak，新 SKILL.md 落位）
  const d1 = path.join(cwd, 'skills1');
  fs.mkdirSync(d1, { recursive: true });
  const i1 = j(run('install-skill.js', ['--dir', d1]));
  assert.equal(i1.ok, true);
  assert.deepEqual(i1.skippedDirs, []);
  assert.equal(i1.backedUp, null);
  assert.equal(fs.existsSync(path.join(d1, 'agent-doc-ops', 'SKILL.md')), true);
  fs.writeFileSync(path.join(d1, 'agent-doc-ops', 'marker.txt'), 'old');
  const i2 = j(run('install-skill.js', ['--dir', d1]));
  assert.equal(i2.ok, true);
  assert.notEqual(i2.backedUp, null);
  assert.equal(fs.existsSync(path.join(expand(i2.backedUp), 'marker.txt')), true);
  assert.equal(fs.existsSync(path.join(d1, 'agent-doc-ops', 'marker.txt')), false);
  assert.equal(fs.existsSync(path.join(d1, 'agent-doc-ops', 'SKILL.md')), true);

  // T6：.bak 只留最近 3 个（重复执行不无限堆）
  const d2 = path.join(cwd, 'skills2');
  fs.mkdirSync(path.join(d2, 'agent-doc-ops'), { recursive: true });
  for (const n of ['0a1', '0a2', '0a3', '0a4']) fs.mkdirSync(path.join(d2, 'agent-doc-ops.bak-' + n));
  const i3 = j(run('install-skill.js', ['--dir', d2]));
  assert.equal(i3.ok, true);
  const baks = fs.readdirSync(d2).filter((n) => n.startsWith('agent-doc-ops.bak-'));
  assert.equal(baks.length, 3);
  assert.equal(baks.includes('agent-doc-ops.bak-0a1'), false);
  assert.equal(baks.includes('agent-doc-ops.bak-0a2'), false);

  // T7：setup --list 在隔离 HOME 下报空探测（不装不错装）
  const sl = j(run('setup.js', ['--list']));
  assert.equal(sl.ok, true);
  assert.deepEqual(sl.detectedSkillDirs, []);

  // T8：system-deps 未知参数/缺值 → invalid-args
  const sb1 = run('install-system-deps.js', ['--banana']);
  assert.equal(sb1.exit, 1);
  assert.equal(j(sb1).code, 'invalid-args');
  const sb2 = run('install-system-deps.js', ['--components']);
  assert.equal(sb2.exit, 1);
  assert.equal(j(sb2).code, 'invalid-args');

  // T9：缺 --yes 一律拒绝（不做任何事）
  const sb3 = run('install-system-deps.js', ['--components', 'tesseract']);
  assert.equal(sb3.exit, 1);
  assert.equal(j(sb3).code, 'refuse-no-confirm');

  // T10：--list 只探测（5 组件＋版本钉齐，无副作用）
  const sb4 = j(run('install-system-deps.js', ['--list']));
  assert.equal(sb4.ok, true);
  assert.equal(sb4.items.length, 5);
  assert.equal(sb4.items.find((x) => x.component === 'tesseract').pin, '5.4.0.20240606');
  assert.ok(sb4.items.every((x) => typeof x.present === 'boolean'));

  // T11：VC++ 无 --include-vc 拒绝（双重显式）
  const sb5 = run('install-system-deps.js', ['--components', 'vc', '--yes']);
  assert.equal(sb5.exit, 1);
  assert.equal(j(sb5).code, 'refuse-needs-explicit');

  // T12：tesseract 缺获取参数拒绝（本仓不硬编码 URL/SHA）
  const sb6 = run('install-system-deps.js', ['--components', 'tesseract', '--yes']);
  assert.equal(sb6.exit, 1);
  assert.equal(j(sb6).code, 'refuse-missing-acquisition');

  // T13：--dry-run 只出计划（给定的 officecli 三件套进计划，零执行）
  const sb7 = j(run('install-system-deps.js', ['--dry-run', '--components', 'officecli',
    '--officecli-url', 'https://example.invalid/o.exe', '--officecli-sha256', 'abc', '--officecli-version', '9.9.9']));
  assert.equal(sb7.ok, true);
  assert.equal(sb7.plans.length, 1);
  assert.deepEqual(sb7.plans[0].missing, []);
  assert.equal(sb7.plans[0].steps[0].url, 'https://example.invalid/o.exe');
  assert.ok(sb7.plans[0].steps.some((s) => s.kind === 'archive' && /officecli-win-x64-9\.9\.9\.exe/.test(s.dest)));

  // T14：setup --with-system-deps 把拒绝原样透出（委托链不断）
  const sb8 = j(run('setup.js', ['--no-deps', '--no-doctor', '--with-system-deps', 'tesseract']));
  assert.equal(sb8.ok, false);
  const dep = sb8.steps.find((s) => s.step === 'system deps → tesseract');
  assert.ok(dep && dep.ok === false && /refuse/.test(dep.detail));

  // T15：install-skill --list 输出占位化（无绝对路径，目录仍可辨认）
  const ld = path.join(cwd, '.codex', 'skills');
  fs.mkdirSync(ld, { recursive: true });
  const l1 = run('install-skill.js', ['--list']);
  assert.equal(j(l1).ok, true);
  assert.ok(j(l1).detected.length >= 1 && j(l1).detected[0].includes('%USERPROFILE%'));
  assert.equal(ABS_RE.test(l1.output), false);

  // T16：char-baseline check 输出占位化（对照基线走 <REPO>，落点相对名）
  const bl = run('test/char-baseline.js', ['check']);
  assert.equal(j(bl).ok, true);
  assert.ok(String(j(bl)['对照基线']).startsWith('<REPO>'));
  assert.equal(ABS_RE.test(bl.output), false);

  // T17：setup --list 输出占位化
  const sl2 = run('setup.js', ['--list']);
  assert.ok(j(sl2).detectedSkillDirs.length >= 1 && j(sl2).detectedSkillDirs[0].includes('%USERPROFILE%'));
  assert.equal(ABS_RE.test(sl2.output), false);

  // T18：install-system-deps --list 输出占位化（本机真实探测亦不得带裸路径）
  const sd = run('install-system-deps.js', ['--list']);
  assert.equal(j(sd).ok, true);
  assert.equal(j(sd).items.length, 5);
  assert.equal(ABS_RE.test(sd.output), false);

  console.log(JSON.stringify({ ok: true, tests: 18 }));
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
