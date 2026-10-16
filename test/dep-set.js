// test/dep-set.js — AUD-2（v1.6.6）：依赖缺失态 SKIP 注册表的生成与校验入口
//
// 两张注册表（都只许跟着机器实测改，"改的是期望值不是松紧"）：
//   test/dep-registry-missing.json — 模拟态（主树 + DOCKIT_KIT_CLI 指不存在路径）的 SKIP 集合，
//                                    与 dockit.js 判据区 `DEP_SKIP_REGISTRY` 数组逐字一致（由 --export-missing 导出）。
//   test/dep-registry-clone.json   — 真克隆态（git clone，无 node_modules、带 .git）的 SKIP 集合。
//
// 子命令：
//   node test/dep-set.js lint            — 秒级：两张表存在/可解析/结构完整/与 DEP_SKIP_REGISTRY 一致（selftest 的 T1 判据吃这条）
//   node test/dep-set.js check           — 全跑：临时 clone → selftest → SKIP 集合逐名比对真克隆注册表（约 2-4 分钟，显式入口）
//   node test/dep-set.js export-missing  — 重导模拟态注册表（DOCKIT_KIT_CLI 指空路径跑 selftest）
//
// 夹具要点（监工 AUD-2 实测的坑）：真克隆夹具**必须带 .git**——否则会把"缺 .git"误读成"缺依赖"。
const { spawnSync: cpSpawnSync } = require('child_process');
// spawn 统一包装（v2.2.3，与 dockit.js 同款）：stdin 钉 'ignore'——本会话宿主里缺省 stdio 的 spawnSync
// 稳定 EBUSY（详见 dockit.js 工具函数区注释）；真克隆 check 要起 selftest 子进程，不钉就全灭。
const SPAWN_STDIO_DEFAULT = ['ignore', 'pipe', 'pipe'];
function spawnSync(exe, args, opts) {
  const o = Object.assign({}, opts || {});
  if (!o.stdio) o.stdio = SPAWN_STDIO_DEFAULT;
  return cpSpawnSync(exe, args, o);
}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const REG_MISSING = path.join(__dirname, 'dep-registry-missing.json');
const REG_CLONE = path.join(__dirname, 'dep-registry-clone.json');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

function readRegistry(file) {
  if (!fs.existsSync(file)) return { err: `注册表不存在：${file}` };
  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { err: `注册表不是合法 JSON：${e.message}` }; }
  if (!Array.isArray(j.names) || !j.names.length) return { err: '注册表缺 names 数组或为空' };
  if (typeof j.count !== 'number' || j.count !== j.names.length) return { err: `注册表 count(${j.count}) 与 names.length(${j.names.length}) 不一致` };
  const uniq = new Set(j.names);
  if (uniq.size !== j.names.length) return { err: '注册表有重名成员' };
  return { names: j.names, count: j.count, generated: j.generated || '(无时间戳)', source: j.source || '' };
}

function dockitRegistryInline() {
  const src = fs.readFileSync(path.join(ROOT, 'dockit.js'), 'utf8');
  const m = /const DEP_SKIP_REGISTRY = \[([\s\S]*?)\n\];/.exec(src);
  if (!m) return null;
  // 逐行 JSON.parse：旧正则 ["']([^"']+)["'] 遇到条目内部的转义引号（如 \"未落盘\"）会把一行切碎成三段
  // （2026-10-15 公开树实抓：lint 报"逐名不一致"而两侧实际一致）。每行都是 JSON.stringify 的输出，直接 parse 最稳。
  const items = [];
  for (const l of m[1].split('\n')) {
    const t = l.trim().replace(/,$/, '');
    if (!t) continue;
    try { items.push(JSON.parse(t)); } catch { return null; }
  }
  return items;
}

function lint() {
  const bad = [];
  const miss = readRegistry(REG_MISSING);
  if (miss.err) bad.push('模拟态注册表：' + miss.err);
  else {
    const inline = dockitRegistryInline();
    if (!inline) bad.push('dockit.js 里找不到 DEP_SKIP_REGISTRY 数组');
    else if (inline.length !== miss.count) bad.push(`模拟态注册表 ${miss.count} 条与 dockit.js DEP_SKIP_REGISTRY ${inline.length} 条不一致`);
    else if (JSON.stringify(inline.slice().sort()) !== JSON.stringify(miss.names.slice().sort())) bad.push('模拟态注册表成员与 dockit.js DEP_SKIP_REGISTRY 逐名不一致');
  }
  const cl = readRegistry(REG_CLONE);
  if (cl.err) bad.push('真克隆注册表：' + cl.err);
  else if (cl.count < 40) bad.push(`真克隆注册表只有 ${cl.count} 条（低于合理下限 40——疑似被清空）`);
  // dep-set.js 自己可被 node 加载（语法面）
  const sc = spawnSync(process.execPath, ['--check', __filename], { encoding: 'utf8' });
  if (sc.status !== 0) bad.push('dep-set.js 语法检查失败：' + String(sc.stderr).slice(0, 120));
  if (bad.length) { console.log(JSON.stringify({ ok: false, op: 'dep-set-lint', bad }, null, 1)); process.exit(1); }
  console.log(JSON.stringify({ ok: true, op: 'dep-set-lint', missing: miss.count && { count: miss.count, generated: miss.generated }, clone: { count: cl.count, generated: cl.generated }, note: 'lint 是秒级结构验证；集合与实测的逐名比对由「依赖覆盖率闸」（模拟态）与 dep-set.js check（真克隆态）承担' }));
}

function checkClone() {
  const reg = readRegistry(REG_CLONE);
  if (reg.err) { console.log(JSON.stringify({ ok: false, op: 'dep-set-check', error: reg.err })); process.exit(1); }
  const tmp = path.join(require('os').tmpdir(), 'dep-set-clone-' + Date.now());
  const cl = spawnSync('git', ['clone', '--no-hardlink', '--quiet', ROOT, tmp], { encoding: 'utf8' });
  if (cl.status !== 0) { console.log(JSON.stringify({ ok: false, op: 'dep-set-check', error: 'clone 失败：' + String(cl.stderr).slice(0, 160) })); process.exit(1); }
  let j = null, stubFails = 0, liveSkips = [], otherReasonCount = 0;
  const skipNote = new Map();
  try {
    if (!fs.existsSync(path.join(tmp, '.git'))) { console.log(JSON.stringify({ ok: false, op: 'dep-set-check', error: '夹具树没有 .git（会把缺 .git 误读成缺依赖——监工踩过的坑）' })); process.exit(1); }
    if (fs.existsSync(path.join(tmp, 'node_modules'))) { console.log(JSON.stringify({ ok: false, op: 'dep-set-check', error: '夹具树不该有 node_modules（这是真克隆态的形状）' })); process.exit(1); }
    const r = spawnSync(process.execPath, [path.join(tmp, 'dockit.js'), 'selftest'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000, cwd: tmp });
    try { j = JSON.parse(r.stdout); } catch {}
    if (!j) { console.log(JSON.stringify({ ok: false, op: 'dep-set-check', error: '真克隆态 selftest 跑不出 JSON：' + String(r.stdout || r.stderr).slice(0, 160) })); process.exit(1); }
    // 剔除设施自身（闸/哨兵不递归 SKIP）与 aud1-stub 控制组（缺失态必红是正确行为）
    liveSkips = (j.checks || []).filter((c) => c.startsWith('SKIP')).map((c) => c.slice(5, c.indexOf(' :: ') < 0 ? undefined : c.indexOf(' :: '))).filter((s) => !s.includes('依赖覆盖率闸') && !s.includes('AUD-1 第四臂哨兵'));
    stubFails = (j.checks || []).filter((c) => c.startsWith('FAIL') && c.includes('aud1-stub')).length;
    if (j.failed !== stubFails) { console.log(JSON.stringify({ ok: false, op: 'dep-set-check', error: '真克隆态 failed=' + j.failed + '（剔除 aud1-stub 控制组后应为 0）' })); process.exit(1); }
    const uniq = [...new Set(liveSkips)].sort();
    const regSorted = reg.names.slice().sort();
    // CI 首绿轮（2026-10-16）：与 dockit.js 覆盖率闸**同口径**——注册表是标定机器的读数，非标定机器上别的
    // 可选前置（pandoc/poppler/tesseract/私仓件）缺失造成的 SKIP 是机器事实、不是漂移，不判红；但注册表里的
    // 每一条都必须还 SKIP，且由 kit 缺失洗出来的 SKIP（wrapT 的固定标记）一条都不许多。
    const KIT_SKIP_MARK = "本条声明了 {needs:'kit'}";
    for (const c of (j.checks || [])) {
      if (!c.startsWith('SKIP')) continue;
      const body = c.slice(5); const cut = body.indexOf(' :: ');
      const nm = cut < 0 ? body : body.slice(0, cut);
      if (!skipNote.has(nm)) skipNote.set(nm, cut < 0 ? '' : body.slice(cut + 4));
    }
    const extra = uniq.filter((s) => !regSorted.includes(s));
    const missing = regSorted.filter((s) => !uniq.includes(s));
    const unregisteredKit = extra.filter((s) => String(skipNote.get(s) || '').includes(KIT_SKIP_MARK));
    const otherReason = extra.filter((s) => !unregisteredKit.includes(s));
    otherReasonCount = otherReason.length;
    if (missing.length || unregisteredKit.length) {
      console.log(JSON.stringify({ ok: false, op: 'dep-set-check', failed: j.failed, stubFails, regCount: reg.count, liveCount: uniq.length, missing, unregisteredKit, otherReason, note: '真克隆态：注册表里的判据没 SKIP，或有吃 kit 的判据没登记——两者都要跟着机器实测改（其它可选前置缺失的多出项按 CI 首绿轮口径不判红）' }, null, 1));
      process.exit(1);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(JSON.stringify({ ok: true, op: 'dep-set-check', failed: j.failed, stubFails, regCount: reg.count, liveCount: liveSkips.length, otherReasonCount, note: '真克隆态：除 aud1-stub 控制组外 failed=0；注册表成员全部 SKIP，且没有「吃 kit 却未登记」的多出项（其它可选前置缺失的多出项逐条带因、不判红）' }));
}

function exportMissing() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'dockit.js'), 'selftest'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000, env: Object.assign({}, process.env, { DOCKIT_KIT_CLI: 'Z:\\__no_kit_for_export__\\cli.js' }) });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  if (!j) { console.log(JSON.stringify({ ok: false, error: '模拟态 selftest 跑不出 JSON' })); process.exit(1); }
  // 与覆盖率闸本体（dockit.js 缺失态对账）同一把剔除尺：闸自身 + AUD-1 第四臂哨兵两者在缺失态都按
  // 「设施自身不递归」SKIP，不属于被闸的依赖集合。v2.1.0 前这里只剔闸自身，导出的表会比 inline
  // DEP_SKIP_REGISTRY 多一条哨兵而 lint 不过（基线表是手工剔除的）；现对齐，export 即可直接产出 lint 绿的表。
  const skips = (j.checks || []).filter((c) => c.startsWith('SKIP')).map((c) => c.slice(5, c.indexOf(' :: ') < 0 ? undefined : c.indexOf(' :: '))).filter((s) => !s.includes('依赖覆盖率闸') && !s.includes('AUD-1 第四臂哨兵')).sort();
  fs.writeFileSync(REG_MISSING, JSON.stringify({ generated: new Date().toISOString(), source: 'DOCKIT_KIT_CLI 指不存在路径的模拟态 selftest；剔除依赖覆盖率闸自身与 AUD-1 第四臂哨兵（设施自身不递归）', count: skips.length, names: skips }, null, 1));
  console.log(JSON.stringify({ ok: true, op: 'export-missing', count: skips.length, written: REG_MISSING }));
}

const cmd = process.argv[2] || 'lint';
if (cmd === 'lint') lint();
else if (cmd === 'check') checkClone();
else if (cmd === 'export-missing') exportMissing();
else { console.log('用法：node test/dep-set.js lint|check|export-missing'); process.exit(2); }
