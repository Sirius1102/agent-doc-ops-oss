// test/char-baseline.js — 本仓允许字符集基线台子（v1.6.0 R3-b，任务书 P5-2／Q-05；收总览第八节第 13 条挂账）
// 用法：node test/char-baseline.js check [--strict]     对基线比差集，报"工作区里基线没有的码点"
//       node test/char-baseline.js selftest             台子自己的正面控制：注入一个基线外汉字**必须红**，全在基线内的样本必须绿
//       node test/char-baseline.js explain <字>          这个码点在不在基线、出现在哪些文件
//       node test/char-baseline.js save                  重写基线 —— 🔴 需机主同意：必须带环境变量 DOCKIT_BASELINE_CONSENT=1 才动
// 为什么需要它：`lang 语言白名单` 判据按码点区间拦假名／谚文／私有区／替换符，**管不到"合法汉字被写错"**
//   （真事：v1.1.3 抓到过一个常用字被写成它的形近生僻字，还有那次反斜杠转义被脚本吞掉）——这两类都是合法字符，只是不该出现在这个仓。
// 闸门口径（刻意的，别改）：`check` 默认**只报不红**（本仓每轮都要写新散文，新汉字是常态）；
//   真正会红的是 ① `--strict`（人工确认这一批不许有新增字时用它）与 ② `selftest` 的注入对照（错字形状必须被抓）。
// 基线管的是**全仓码点集合**，不追踪字符在文件间的位置（v3.0.1 审查轮补记）：把一段字从 A 文件挪到 B 文件，
//   check 与 selftest 都不会红——挪动不产生基线外语料，这是设计语义；要审"哪处文本该有哪几个字"属内容审校，不属这台尺。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync: cpSpawnSync } = require('node:child_process');
// Keep child-process calls on the same stdio contract as the other test hosts.
const SPAWN_STDIO_DEFAULT = ['ignore', 'pipe', 'pipe'];
function spawnSync(exe, args, opts) {
  const o = Object.assign({}, opts || {});
  if (!o.stdio) o.stdio = SPAWN_STDIO_DEFAULT;
  return cpSpawnSync(exe, args, o);
}

const ROOT = path.resolve(__dirname, '..');
// 基线路径可改（判据要从**外面**验 save 的拒绝逻辑，若不可改，那条反向测试在"闸门被拆掉"的变异下会真把基线覆盖掉）
const BASELINE = process.env.DOCKIT_CHAR_BASELINE_PATH || path.join(__dirname, 'baseline-chars.json');
// 扫描面复用装置自己的那份清单（单一来源），再补上 docs/adr 与本目录的台子
// 公开树版：装置把 LANG_FILES 导出为惰性函数 langFiles()，这里跟着调用。
const { LANG_FILES } = require('../dockit.js');
const langFiles = typeof LANG_FILES === 'function' ? LANG_FILES : () => LANG_FILES;
const EXTRA = ['test/char-baseline.js', 'test/baseline-fonts.js'];
const files = () => {
  const adrDir = path.join(ROOT, 'docs', 'adr');
  const adrs = fs.existsSync(adrDir) ? fs.readdirSync(adrDir).filter((f) => f.endsWith('.md')).map((f) => 'docs/adr/' + f) : [];
  return [...new Set([...langFiles(), ...EXTRA, ...adrs])].filter((rel) => fs.existsSync(path.join(ROOT, rel)));
};
const cpOf = (ch) => ch.codePointAt(0);
const isAllowedShape = (cp) => !(cp <= 8 || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f) || cp === 0x7f);
// 只统计"非 ASCII 且不是标点噪声"的码点：ASCII 全量放行（代码与命令行靠它）
const track = (txt) => {
  const set = new Set();
  for (const ch of txt) { const cp = cpOf(ch); if (cp < 0x80) continue; if (!isAllowedShape(cp)) continue; set.add(cp); }
  return set;
};
const scan = () => {
  const per = {}; const all = new Set(); const hits = new Map();
  for (const rel of files()) {
    const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const s = track(txt);
    per[rel] = [...s].sort((a, b) => a - b);
    for (const cp of s) { all.add(cp); if (!hits.has(cp)) hits.set(cp, []); hits.get(cp).push(rel); }
  };
  return { per, all, hits };
};
const readBaseline = () => {
  if (!fs.existsSync(BASELINE)) return null;
  const j = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  return { set: new Set(j.codepoints || []), meta: j };
};
// 注入候选：都是"合法汉字但本仓不该有"的形状。selftest 会挑一个**不在基线里**的来注入，
// 若五个候选全被纳入了基线 ⇒ 台子自己报"这条没牙"，不许假称验过。
// 候选**只写码点**：这几个字的字面一旦出现在本文件里就会被扫进基线，注入对照当场作废（0x5470 就是历史上那个形近字）。
const INJECT_CANDIDATES = [0x5470, 0x5639, 0x9FCC, 0x58B3, 0x6C57];

const argv = process.argv.slice(2);
const mode = argv[0] || 'check';
const out = (o) => console.log(JSON.stringify(o));

if (mode === 'check' || mode === 'save' || mode === 'init') {
  const { all, hits, per } = scan();
  const b = readBaseline();
  if (mode === 'init') {
    // 首次创建 ≠ 重写：闸门靠 consent 的是"把漂移的基线覆盖掉"这个动作（那等于为了让台子绿而扩集合）。
    // 基线不存在时把它建起来是本工具的交付内容本身，所以 init 只在**没有基线文件**时可用，且写完就拒绝再跑。
    if (b) { out({ ok: false, op: 'init', refused: true, why: '基线已在位（' + BASELINE + '，' + b.meta.codepointCount + ' 个码点）；要重写只能走 save 且需 DOCKIT_BASELINE_CONSENT=1' }); process.exit(1); }
    const data = { 生成: new Date().toISOString(), 工具: 'test/char-baseline.js init（仅首次创建；重写必须走 save + 同意）', 基线来源: '当前工作树', 文件数: Object.keys(per).length, 文件清单: Object.keys(per).sort(), codepointCount: all.size, codepoints: [...all].sort((x, y) => x - y) };
    fs.writeFileSync(BASELINE, JSON.stringify(data, null, 0) + '\n');
    out({ ok: true, op: 'init', 文件数: data.文件数, codepointCount: all.size, 基线字节: fs.statSync(BASELINE).size, 基线来源: data.基线来源 });
    process.exit(0);
  }
  if (mode === 'save') {
    if (process.env.DOCKIT_BASELINE_CONSENT !== '1') {
      out({ ok: false, op: 'save', refused: true, why: '重写基线要机主同意（与字体基线同一条口径）：设 DOCKIT_BASELINE_CONSENT=1 才动', 现有基线: b ? b.meta.codepointCount : 0, 本次实算: all.size });
      process.exit(1);
    }
    const data = { 生成: new Date().toISOString(), 工具: 'test/char-baseline.js save（需 DOCKIT_BASELINE_CONSENT=1）', 基线来源: '当前工作树', 文件数: Object.keys(per).length, 文件清单: Object.keys(per).sort(), codepointCount: all.size, codepoints: [...all].sort((x, y) => x - y) };
    fs.writeFileSync(BASELINE, JSON.stringify(data, null, 0) + '\n');
    out({ ok: true, op: 'save', 文件数: data.文件数, codepointCount: all.size, 基线字节: fs.statSync(BASELINE).size });
    process.exit(0);
  }
  if (!b) { out({ ok: false, op: 'check', why: '基线文件不在：' + BASELINE, 实算码点数: all.size }); process.exit(1); }
  // --at <路径>：对照**另一份**基线跑（复盘/迁移用；也是"消失清单"这条尺的自证入口——
  //   基线与语料相同时真实消失恒为 0，那时任何"消失算坏了"的实现都不会被发现，必须能造一个已知消失出来量）。
  const atIdx = argv.indexOf('--at');
  // 🔴 v3.0.0（自检自修实抓）：--at 给了却不给值／后面直接跟另一个开关——不许被静默忽略（静默会照跑原基线，
  //    让"对照另一份基线"变成一句谎）；与 v2.4.1"空页清单假成功"同族。
  if (atIdx >= 0 && (!argv[atIdx + 1] || String(argv[atIdx + 1]).startsWith('--'))) { out({ ok: false, op: 'check', why: '--at 缺值：要对照另一份基线请给 <路径>；不给 --at 才等于对照默认基线' }); process.exit(1); }
  const atPath = atIdx >= 0 ? path.resolve(ROOT, String(argv[atIdx + 1])) : null;
  let bUse = b;
  let atApplied = null; // 🔴 只有真的换了对照件才敢说"对照的是这份"——否则这个字段会变成一句谎（M256 的形状）
  if (atPath) {
    if (!fs.existsSync(atPath)) { out({ ok: false, op: 'check', why: `--at 指的基线文件不在：${atPath}` }); process.exit(1); }
    let parsed; try { parsed = JSON.parse(fs.readFileSync(atPath, 'utf8')); } catch (e) { out({ ok: false, op: 'check', why: `--at 基线解析失败：${String(e.message).slice(0, 120)}` }); process.exit(1); }
    if (!Array.isArray(parsed.codepoints)) { out({ ok: false, op: 'check', why: `--at 基线里没有 codepoints 数组：${atPath}` }); process.exit(1); }
    bUse = { meta: parsed, set: new Set(parsed.codepoints) };
    atApplied = atPath;
  }
  const extra = [...all].filter((cp) => !bUse.set.has(cp)).sort((x, y) => x - y);
  const gone = [...bUse.set].filter((cp) => !all.has(cp)).sort((x, y) => x - y);
  const strict = argv.includes('--strict');
  out({
    ok: strict ? extra.length === 0 : true, op: 'check', strict,
    基线码点数: bUse.set.size, 实算码点数: all.size, 基线生成: bUse.meta.生成, 基线来源: bUse.meta.基线来源 || '未记录',
    对照基线: atApplied || BASELINE,
    新增码点数: extra.length, 新增码点: extra.slice(0, 60).map((cp) => 'U+' + cp.toString(16) + '(' + String.fromCodePoint(cp) + ')'),
    消失码点数: gone.length,
    // 「消失」以前只给条数不给清单：基线里有过、现在全文扫不到的码点，多半是某段文本被删掉或改坏了。
    // 只报数不报字，人工过目这一关就形同虚设（2026-10-14 审查发现，升版前那条 strict 流程要靠它能逐条认领）。
    消失码点: gone.slice(0, 60).map((cp) => 'U+' + cp.toString(16) + '(' + String.fromCodePoint(cp) + ')'),
    消失落点: gone.slice(0, 12).map((cp) => 'U+' + cp.toString(16) + '(' + String.fromCodePoint(cp) + ') @ 基线件（现全仓扫不到）'),
    新增落点: extra.slice(0, 12).map((cp) => 'U+' + cp.toString(16) + '(' + String.fromCodePoint(cp) + ') @ ' + (hits.get(cp) || []).join(',')),
    扫描文件: Object.keys(per).length,
    note: '默认 check 只报不红（本仓每轮写新散文，新汉字是常态）；要拿它当闸门用 --strict，或跑 selftest 验"错字形状必须被抓"',
  });
  process.exit(strict && extra.length ? 1 : 0);
}

if (mode === 'selftest') {
  const b = readBaseline();
  if (!b) { out({ ok: false, op: 'selftest', why: '基线文件不在，无从对照' }); process.exit(1); }
  const bad = [];
  const cand = INJECT_CANDIDATES.find((cp) => !b.set.has(cp));
  if (cand === undefined) { out({ ok: false, op: 'selftest', why: '注入候选全部已在基线内 ⇒ 这条没有牙，不许当验过：' + INJECT_CANDIDATES.map((c) => 'U+' + c.toString(16)).join(','), 必须: '人工把混进基线的生僻字从基线里清出去（要机主同意跑 save）' }); process.exit(1); }
  // ① 注入基线外汉字 ⇒ 必须被判为"新增"
  const inject = String.fromCodePoint(cand);
  const injected = track('一段用来验证哨兵的文本，故意把常用字换成 ' + inject + ' 这个合法汉字。');
  const missed = [...injected].filter((cp) => !b.set.has(cp));
  if (missed.length !== 1 || missed[0] !== cand) bad.push('注入 ' + 'U+' + cand.toString(16) + '(' + inject + ') 没被抓到（抓到 ' + JSON.stringify(missed.map((c) => c.toString(16))) + '）');
  // ② 全在基线内的文本 ⇒ 必须干净（否则哨兵是永远红的假牙）
  const cleanSet = [...injected].filter((cp) => b.set.has(cp));
  const clean = track('这一句里的每个汉字都来自本仓已有文本，应当零新增：装置自检夹具常用汉字串。');
  const falsePos = [...clean].filter((cp) => !b.set.has(cp));
  if (falsePos.length) bad.push('全基线内样本被判成新增（哨兵过度）：' + falsePos.map((c) => 'U+' + c.toString(16)).join(','));
  if (!cleanSet.length) bad.push('对照集为空，注入检查是空转');
  // ③ 控制字符/替换符这一族**不进基线**（它们由 lang 与 doc 卫生 判据拦，这里混进来就是两把尺打架）
  const weird = [0x0c, 0xfffd, 0x3042].filter((cp) => b.set.has(cp));
  if (weird.length) bad.push('基线里混进了本该由别的判据拦的码点：' + weird.map((c) => 'U+' + c.toString(16)).join(',') + '（0x0C／U+FFFD／假名）');
  out({ ok: bad.length === 0, op: 'selftest', 注入用码点: 'U+' + cand.toString(16), 注入字符: inject, 基线码点数: b.set.size, 对照集大小: cleanSet.length, 失败: bad });
  process.exit(bad.length ? 1 : 0);
}

if (mode === 'explain') {
  const ch = argv[1] || '';
  if (!ch) { out({ ok: false, op: 'explain', why: '要给一个字符：node test/char-baseline.js explain <任意字>' }); process.exit(1); }
  const cp = cpOf(ch);
  const b = readBaseline();
  const where = [];
  for (const [rel, list] of Object.entries(scan().per)) if (list.includes(cp)) where.push(rel);
  out({ ok: true, op: 'explain', char: ch, codepoint: 'U+' + cp.toString(16), 在基线内: !!b && b.set.has(cp), 出现的文件: where });
  process.exit(0);
}

out({ ok: false, op: mode || 'none', why: '未知用法：可用 check [--strict] | selftest | explain <字> | save（save 需 DOCKIT_BASELINE_CONSENT=1）' });
process.exit(1);
