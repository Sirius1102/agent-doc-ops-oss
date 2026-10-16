#!/usr/bin/env node
'use strict';
// install-system-deps.js — 系统侧依赖的显式 assisted 安装（默认什么都不装）。
//
// 约束（发布前审计结论，不可绕过）：
// - 默认只探测（--list / --dry-run）。任何写操作（下载/安装/解压/归档/PATH 变更/提权）
//   都必须显式 --yes；没有 --yes 一律拒绝（refuse），不做任何事。
// - VC++ v14 运行库：需管理员＋机器级＋可能重启，永不静默装——除 --yes 外还要
//   --include-vc 双重显式；执行时只起安装包自己的交互界面（不传静默开关），重启由用户自己决定。
// - Tesseract：版本钉 5.4.0.20240606，落点 C:\Program Files\Tesseract-OCR（安装包默认），
//   语言包目录可 DOCKIT_TESSDATA 覆盖；下载 URL 与 SHA256 必须由调用方显式给出
//   （--tesseract-url / --tesseract-sha256，或 SYSDEPS_ 同名环境变量），本仓不硬编码下载地址。
// - Poppler/Pandoc：GPL/外部上游，不进仓分发——走 winget（调用方给 --poppler-winget-id /
//   --pandoc-winget-id，可另给 --*-winget-version 钉版本）或自备安装包（--poppler-url＋--poppler-sha256）；
//   版本钉由调用方给出，本工具只执行＋如实记录（否则判据随上游漂）。
// - OfficeCLI：必须先有公开获取面——URL＋SHA256＋版本号必须显式给（--officecli-url /
//   --officecli-sha256 / --officecli-version），下载后按单文件 sha256 全值校验，归档到用户目录
//   bin\archive（不进仓），并写 acquisition.json 留三源认领底（URL/sha/版本/日期）。
//   本工具只负责取 binary；动词白名单（只许 set/add/remove/merge/validate）由 dockit 侧 enforcement。
// - 本工具不写注册表、不改 PATH、不提权：装完只报"怎么指过去"（DOCKIT_* 环境变量），由调用方自己配。
// - 仅支持 Windows（与 package.json os 字段一致）；verify 统一走 `node dockit.js doctor`。
//
// 用法：
//   node install-system-deps.js --list
//   node install-system-deps.js --dry-run [--components vc,tesseract,poppler,pandoc,officecli] [各组件参数]
//   node install-system-deps.js --components <csv|all> --yes [各组件参数] [--include-vc]
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname);
const DOCKIT = path.join(ROOT, 'dockit.js');
const LOCALAPP = process.env.LOCALAPPDATA || path.join(os.homedir() || '', 'AppData', 'Local');
const OFFICECLI_ARCHIVE_DIR = path.join(LOCALAPP, 'agent-doc-ops', 'bin', 'archive');

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

const COMPONENTS = {
  vc: { title: 'VC++ v14 运行库（x64）', pin: 'v14.x x64（随 Visual Studio 运行库发布）', needsAdmin: true, mayReboot: true },
  tesseract: { title: 'Tesseract OCR + chi_sim', pin: '5.4.0.20240606', installDir: 'C:\\Program Files\\Tesseract-OCR', env: ['DOCKIT_TESSDATA', 'DOCKIT_TESSERACT'] },
  poppler: { title: 'Poppler（pdftotext/pdfimages/pdftoppm）', pin: '调用方钉版本（--poppler-winget-version）或自备包', env: ['DOCKIT_POPPLER_BIN'] },
  pandoc: { title: 'Pandoc', pin: '调用方钉版本（--pandoc-winget-version）或自备包', env: ['DOCKIT_PANDOC'] },
  officecli: { title: 'OfficeCLI 写后端', pin: 'v1.0.153–v1.0.157 lineage（见 docs/adr/ADR-002）', env: ['DOCKIT_OFFICECLI'], archiveDir: OFFICECLI_ARCHIVE_DIR },
};
const ALL = Object.keys(COMPONENTS);

// ---- 参数 ----
function parse(argv) {
  const a = { list: false, dryRun: false, components: null, yes: false, includeVc: false, params: {}, bad: null };
  let i = 0;
  const take = (flag, key) => {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) { a.bad = { code: 'invalid-args', error: `${flag} 缺值`, next: `用 ${flag} <值> 给出` }; return false; }
    a.params[key] = v; i++;
    return true;
  };
  for (i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--list') a.list = true;
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--yes') a.yes = true;
    else if (x === '--include-vc') a.includeVc = true;
    else if (x === '--components') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { a.bad = { code: 'invalid-args', error: '--components 缺值', next: '用 --components <vc,tesseract,poppler,pandoc,officecli|all>' }; break; }
      a.components = v === 'all' ? [...ALL] : v.split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = a.components.filter((c) => !ALL.includes(c));
      if (unknown.length) { a.bad = { code: 'invalid-args', error: `未知组件：${unknown.join(',')}`, next: `组件名限 ${ALL.join('/')}` }; break; }
      i++;
    }
    else if (x === '--tesseract-url') { if (!take(x, 'tesseract-url')) break; }
    else if (x === '--tesseract-sha256') { if (!take(x, 'tesseract-sha256')) break; }
    else if (x === '--poppler-winget-id') { if (!take(x, 'poppler-winget-id')) break; }
    else if (x === '--poppler-winget-version') { if (!take(x, 'poppler-winget-version')) break; }
    else if (x === '--poppler-url') { if (!take(x, 'poppler-url')) break; }
    else if (x === '--poppler-sha256') { if (!take(x, 'poppler-sha256')) break; }
    else if (x === '--pandoc-winget-id') { if (!take(x, 'pandoc-winget-id')) break; }
    else if (x === '--pandoc-winget-version') { if (!take(x, 'pandoc-winget-version')) break; }
    else if (x === '--pandoc-url') { if (!take(x, 'pandoc-url')) break; }
    else if (x === '--pandoc-sha256') { if (!take(x, 'pandoc-sha256')) break; }
    else if (x === '--officecli-url') { if (!take(x, 'officecli-url')) break; }
    else if (x === '--officecli-sha256') { if (!take(x, 'officecli-sha256')) break; }
    else if (x === '--officecli-version') { if (!take(x, 'officecli-version')) break; }
    else if (x === '--vc-url') { if (!take(x, 'vc-url')) break; }
    else if (x === '--vc-sha256') { if (!take(x, 'vc-sha256')) break; }
    else { a.bad = { code: 'invalid-args', error: `未知参数：${x}`, next: '检查 install-system-deps.js 参数拼写' }; break; }
  }
  return a;
}
const P = (a, k, env) => a.params[k] || process.env[env || ('SYSDEPS_' + k.toUpperCase().replace(/-/g, '_'))] || null;

// ---- 探测（只读，无副作用） ----
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function probe(name) {
  if (name === 'vc') {
    const r = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', '/v', 'Version'], { encoding: 'utf8', timeout: 15000 });
    const m = String(r.stdout || '').match(/Version\s+REG_SZ\s+(\S+)/);
    return { present: !!m, detail: m ? `Version=${m[1]}` : '注册表无 x64 v14 Runtime 记录' };
  }
  if (name === 'tesseract') {
    const exe = process.env.DOCKIT_TESSERACT || 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe';
    return { present: exists(exe), detail: exe };
  }
  if (name === 'poppler') {
    const bin = process.env.DOCKIT_POPPLER_BIN || path.join(LOCALAPP, 'Programs', 'poppler', 'Library', 'bin');
    return { present: exists(path.join(bin, 'pdftotext.exe')), detail: bin };
  }
  if (name === 'pandoc') {
    if (process.env.DOCKIT_PANDOC && exists(process.env.DOCKIT_PANDOC)) return { present: true, detail: process.env.DOCKIT_PANDOC };
    const r = spawnSync('where.exe', ['pandoc'], { encoding: 'utf8', timeout: 15000 });
    const hit = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
    return { present: !!hit, detail: hit || 'PATH 无 pandoc' };
  }
  if (name === 'officecli') {
    const exe = process.env.DOCKIT_OFFICECLI || '';
    return { present: !!(exe && exists(exe)), detail: exe || 'DOCKIT_OFFICECLI 未指（配置区默认空）' };
  }
  return { present: false, detail: '未知组件' };
}

// ---- 计划（纯构造，不执行） ----
function planFor(name, a) {
  const c = COMPONENTS[name];
  const pr = probe(name);
  const plan = { component: name, title: c.title, pin: c.pin, present: pr.present, probeDetail: foldPath(pr.detail), steps: [], warnings: [], missing: [] };
  if (c.needsAdmin) plan.warnings.push('需管理员权限（机器级安装）');
  if (c.mayReboot) plan.warnings.push('安装后可能要求重启——重启由用户自己决定，本工具不自动重启');
  plan.warnings.push('安装包界面需一次人工点击（不传静默开关）；本工具不写注册表、不改 PATH');
  if (name === 'vc') {
    const url = P(a, 'vc-url'), sha = P(a, 'vc-sha256');
    if (!url || !sha) plan.missing.push('VC++ 重分发 exe 的 URL 与 SHA256（--vc-url / --vc-sha256）：微软官网下载页取当前 v14.x x64 包，核对后填入');
    plan.steps.push({ kind: 'download', url: url || '(待调用方给出)', dest: '<temp>\\vc_redist.x64.exe' });
    plan.steps.push({ kind: 'verify-sha256', sha256: sha || '(待调用方给出)' });
    plan.steps.push({ kind: 'run-installer', exe: '<temp>\\vc_redist.x64.exe', args: [], interactive: true });
    plan.steps.push({ kind: 'doctor', check: 'VC++ 运行库探针（FAIL 类）' });
  }
  if (name === 'tesseract') {
    const url = P(a, 'tesseract-url'), sha = P(a, 'tesseract-sha256');
    if (!url || !sha) plan.missing.push(`UB-Mannheim 构建（版本钉 ${c.pin}）的 URL 与 SHA256（--tesseract-url / --tesseract-sha256）`);
    if (url && !/5\.4\.0\.20240606/.test(url)) plan.missing.push(`URL 看不出版本钉 ${c.pin}——换与 pin 一致的构建`);
    plan.steps.push({ kind: 'download', url: url || '(待调用方给出)', dest: '<temp>\\tesseract-setup.exe' });
    plan.steps.push({ kind: 'verify-sha256', sha256: sha || '(待调用方给出)' });
    plan.steps.push({ kind: 'run-installer', exe: '<temp>\\tesseract-setup.exe', args: [], interactive: true, defaultDir: foldPath(c.installDir) });
    plan.steps.push({ kind: 'env-note', text: `语言包目录可用 ${c.env[0]} 覆盖；装完用 doctor 的 tesseract-ocr / ocr-lang-pack 验收` });
    plan.steps.push({ kind: 'doctor', check: 'tesseract-ocr, ocr-lang-pack（WARN 类）' });
  }
  if (name === 'poppler' || name === 'pandoc') {
    const wid = P(a, name + '-winget-id'), wver = P(a, name + '-winget-version');
    const url = P(a, name + '-url'), sha = P(a, name + '-sha256');
    if (!wid && !(url && sha)) plan.missing.push(`二选一：winget 包 ID（--${name}-winget-id，可另给 --${name}-winget-version 钉版本）或自备安装包（--${name}-url＋--${name}-sha256）`);
    if (wid) {
      plan.steps.push({ kind: 'winget', id: wid, version: wver || '(winget 当前默认，版本由调用方记录)', interactive: true });
      if (!wver) plan.warnings.push('没钉 winget 版本——装完把实际版本记下来（否则判据随上游漂）');
    } else {
      plan.steps.push({ kind: 'download', url: url || '(待调用方给出)', dest: `<temp>\\${name}-setup` });
      plan.steps.push({ kind: 'verify-sha256', sha256: sha || '(待调用方给出)' });
      plan.steps.push({ kind: 'run-installer', exe: `<temp>\\${name}-setup`, args: [], interactive: true });
    }
    plan.steps.push({ kind: 'env-note', text: `装完把 bin 目录指给 ${c.env[0]}（缺省解析见 doctor）` });
    plan.steps.push({ kind: 'doctor', check: name === 'poppler' ? 'aux-tools/poppler-pdf-text-media（WARN 类）' : 'pandoc-markdown（WARN 类）' });
  }
  if (name === 'officecli') {
    const url = P(a, 'officecli-url'), sha = P(a, 'officecli-sha256'), ver = P(a, 'officecli-version');
    if (!url || !sha || !ver) plan.missing.push('公开获取三件套：--officecli-url / --officecli-sha256 / --officecli-version（版本号如 1.0.157；sha 为单文件全值）');
    plan.steps.push({ kind: 'download', url: url || '(待调用方给出)', dest: '<temp>\\officecli-win-x64.exe' });
    plan.steps.push({ kind: 'verify-sha256', sha256: sha || '(待调用方给出)', note: '单文件全值校验（Release 自带 SHA256SUMS 口径）' });
    plan.steps.push({ kind: 'archive', dest: path.join(c.archiveDir, `officecli-win-x64-${ver || '<版本>'}.exe`), note: '归档到用户目录（不进仓）并写 acquisition.json（URL/sha/版本/日期）' });
    plan.steps.push({ kind: 'env-note', text: `用 DOCKIT_OFFICECLI 指到归档件；动词白名单（只许 set/add/remove/merge/validate）由 dockit 侧 enforcement` });
    plan.steps.push({ kind: 'doctor', check: 'officecli-write-backend（WARN 类）' });
  }
  return plan;
}

// ---- 执行 ----
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function download(url, dest) {
  const r = spawnSync('curl.exe', ['-L', '--fail', '--connect-timeout', '20', '-o', dest, url], { encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) throw new Error(`下载失败（curl 退码 ${r.status}）：${String(r.stderr || r.stdout).slice(0, 160)}`);
}
function execPlan(plan) {
  const log = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockit-sysdeps-'));
  try {
    for (const s of plan.steps) {
      if (s.kind === 'download') {
        if (!plan.missing.length || !/待调用方给出/.test(s.url)) { /* 缺件已在校验层拦住，到这里 url 必全 */ }
        const dest = path.join(tmp, path.basename(s.dest));
        download(s.url, dest);
        s._local = dest;
        log.push(`下载 OK：${foldPath(dest)}`);
      } else if (s.kind === 'verify-sha256') {
        const dl = plan.steps.find((x) => x._local);
        const actual = sha256File(dl._local);
        if (actual.toLowerCase() !== String(s.sha256).toLowerCase()) throw new Error(`SHA256 不一致：实算 ${actual.slice(0, 16)}… ≠ 登记 ${String(s.sha256).slice(0, 16)}…（拒装）`);
        log.push('SHA256 全值一致');
      } else if (s.kind === 'winget') {
        const args = ['install', '--id', plan._wingetId, ...(plan._wingetVersion ? ['-v', plan._wingetVersion] : [])];
        const r = spawnSync('winget', args, { stdio: 'inherit', timeout: 600000 });
        if (r.status !== 0) throw new Error(`winget 退码 ${r.status}（交互安装未完成）`);
        log.push('winget 执行结束（交互）');
      } else if (s.kind === 'run-installer') {
        const dl = plan.steps.find((x) => x._local);
        const r = spawnSync(dl._local, s.args || [], { stdio: 'inherit', timeout: 600000 });
        if (r.status !== 0) throw new Error(`安装包退码 ${r.status}（交互安装未完成）`);
        log.push('安装包执行结束（交互，需人工点击）');
      } else if (s.kind === 'archive') {
        const dl = plan.steps.find((x) => x._local);
        fs.mkdirSync(path.dirname(s.dest), { recursive: true });
        fs.copyFileSync(dl._local, s.dest);
        fs.writeFileSync(path.join(path.dirname(s.dest), 'acquisition.json'), JSON.stringify({ url: plan._url, sha256: plan._sha, version: plan._ver, date: new Date().toISOString() }, null, 1));
        log.push(`已归档（dest 已折叠显示，见 dry-run 计划）：${foldPath(s.dest)}`);
      } else if (s.kind === 'env-note') {
        log.push('指路：' + s.text);
      } else if (s.kind === 'doctor') {
        log.push('验收：跑 node dockit.js doctor 看「' + s.check + '」');
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  return log;
}

function fail(obj) {
  console.error(JSON.stringify(Object.assign({ ok: false, op: 'install-system-deps' }, obj)));
  process.exit(1);
}

function main(argv) {
  const a = parse(argv);
  if (a.bad) fail(a.bad);
  if (process.platform !== 'win32') fail({ code: 'unsupported-platform', error: `仅支持 Windows（当前 ${process.platform}）`, next: '换 Windows 机器跑；package.json os 已钉死 win32' });
  if (a.list) {
    const items = ALL.map((c) => Object.assign({ component: c }, COMPONENTS[c], probe(c)));
    for (const it of items) { if (it.detail) it.detail = foldPath(it.detail); if (it.archiveDir) it.archiveDir = foldPath(it.archiveDir); if (it.installDir) it.installDir = foldPath(it.installDir); }
    console.log(JSON.stringify({ ok: true, op: 'list', items, note: '只探测不装机；装机走 --dry-run 先看计划，再 --components … --yes 执行' }));
    return;
  }
  const comps = a.components || [...ALL];
  const plans = comps.map((c) => planFor(c, a));
  if (a.dryRun) {
    const shown = plans.map((p) => Object.assign({}, p, { steps: p.steps.map((s) => (s.dest ? Object.assign({}, s, { dest: foldPath(s.dest) }) : s)) }));
    console.log(JSON.stringify({ ok: true, op: 'dry-run', plans: shown, note: '只打印计划，不下载不安装；执行加 --yes（VC++ 另需 --include-vc）' }));
    return;
  }
  if (!a.yes) fail({ code: 'refuse-no-confirm', error: '缺 --yes：系统依赖安装必须显式确认', next: '先 --dry-run 看计划，再 --components <csv|all> --yes 执行', plans: plans.map((p) => ({ component: p.component, missing: p.missing })) });
  // 显式执行前的逐项校验
  for (const p of plans) {
    if (p.component === 'vc' && !a.includeVc) fail({ code: 'refuse-needs-explicit', error: 'VC++ 运行库需双重显式（--yes＋--include-vc）：管理员＋机器级＋可能重启', next: '确认接受后加 --include-vc 重跑' });
    if (p.missing.length) fail({ code: 'refuse-missing-acquisition', error: `${p.component} 缺获取参数：${p.missing.join('；')}`, next: '按 missing 逐条给出（URL/SHA/版本可走 SYSDEPS_* 环境变量）' });
  }
  const results = [];
  for (const p of plans) {
    const wid = P(a, p.component + '-winget-id'), wver = P(a, p.component + '-winget-version');
    p._wingetId = wid; p._wingetVersion = wver;
    if (p.component === 'officecli') { p._url = P(a, 'officecli-url'); p._sha = P(a, 'officecli-sha256'); p._ver = P(a, 'officecli-version'); }
    try {
      const log = execPlan(p);
      results.push({ component: p.component, ok: true, log });
    } catch (e) {
      results.push({ component: p.component, ok: false, error: String((e && e.message) || e).slice(0, 200) });
      console.error(JSON.stringify({ ok: false, op: 'install-system-deps', results, next: '看 error 原文；已下载的临时件已清，已归档的不动' }));
      process.exit(1);
    }
  }
  console.log(JSON.stringify({ ok: true, op: 'install-system-deps', results, next: '跑 node dockit.js doctor 验收各组件探针' }));
}

main(process.argv.slice(2));
