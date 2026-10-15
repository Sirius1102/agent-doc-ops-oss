// test/font-baseline.js — 字体供给基线对账（v1.0.2 起常驻）
// 为什么单独一个台子：装置自带引擎，但**字体走系统字体库**。LibreOffice 曾往 C:\Windows\Fonts 装了
// 一批度量兼容替身（Carlito/Caladea/Liberation/DejaVu/Noto/Gentium/Rubik…），删任何程序都可能悄悄改掉
// 转换结果的嵌入字体。这个台子把"哪些族名当前解析到哪个字体文件"钉成基线，环境一变就给差异清单。
// 用法：node test/font-baseline.js save     记录/覆盖基线（要机主明确同意才覆盖）
//       node test/font-baseline.js check    对账（默认）：全一致退 0；有差异退 1 并逐条列
// 判据形状：只比"族名 → 嵌入字体名集合 + missingFonts"，不比 PDF 字节（PDF 每次时间戳不同，必然假红）
const { spawnSync: cpSpawnSync } = require('node:child_process');
// spawn 统一包装（v2.2.3，与 dockit.js 同款）：stdin 钉 'ignore'——本会话宿主里缺省 stdio 的 spawnSync
// 稳定 EBUSY（详见 dockit.js 工具函数区注释）。
const SPAWN_STDIO_DEFAULT = ['ignore', 'pipe', 'pipe'];
function spawnSync(exe, args, opts) {
  const o = Object.assign({}, opts || {});
  if (!o.stdio) o.stdio = SPAWN_STDIO_DEFAULT;
  return cpSpawnSync(exe, args, o);
}
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(__dirname, 'baseline-fonts.json');
const WORK = path.join(ROOT, '_tmp', 'font-baseline');
const FAMILIES = [
  // LO 装入系统库的那批（删除风险面）
  'Carlito', 'Caladea', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono',
  'DejaVu Sans', 'DejaVu Serif', 'Noto Sans', 'Noto Serif', 'Gentium Basic',
  'Rubik', 'Amiri', 'Alef', 'David Libre', 'Miriam Libre', 'Cousine', 'Tinos', 'Arimo',
  // 中文与系统本体（对照组：这几族不该随 LO 卸载变化）
  '宋体', '微软雅黑', '黑体', 'KaiTi', 'SimSun', 'Arial', 'Times New Roman', 'Courier New',
];
const TAG = (f) => f.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '_');

function docx(family) {
  const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const body = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="${family}" w:hAnsi="${family}" w:eastAsia="${family}"/></w:rPr><w:t>font baseline probe ${family} 0123456789 汉字串</w:t></w:r></w:p></w:body></w:document>`;
  const { zipWrite } = require(path.join(ROOT, 'dockit.js'));   // 用装置自己的手写 ZIP（不依赖 kit 的传递依赖）
  return zipWrite([{ name: '[Content_Types].xml', data: Buffer.from(CT) }, { name: '_rels/.rels', data: Buffer.from(RELS) }, { name: 'word/document.xml', data: Buffer.from(body) }]);
}

function embedded(file) {
  const b = fs.readFileSync(file);
  let hay = b.toString('latin1');
  let i = 0;
  while (true) {
    const s = b.indexOf('stream', i); if (s < 0) break;
    const e = b.indexOf('endstream', s); if (e < 0) break;
    try { hay += zlib.inflateSync(b.subarray(s + 6, e)).toString('latin1'); } catch { }
    i = e + 9;
  }
  const names = [...new Set([...hay.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-_]+)/g)].map((m) => m[1].replace(/^[A-Z]{6}\+/, '')))];
  return names.sort();
}

function measure() {
  fs.mkdirSync(WORK, { recursive: true });
  const res = {};
  for (const fam of FAMILIES) {
    const d = path.join(WORK, TAG(fam) + '.docx');
    const p = path.join(WORK, TAG(fam) + '.pdf');
    fs.writeFileSync(d, docx(fam));
    fs.rmSync(p, { force: true });
    const r = spawnSync(process.execPath, [path.join(ROOT, 'dockit.js'), 'to', d, p], { encoding: 'utf8', timeout: 120000 });
    let j = null; try { j = JSON.parse(r.stdout); } catch { }
    if (!j || !j.ok) { res[fam] = { error: (j && j.error) || 'no-json', embedded: null, missingFonts: null }; continue; }
    res[fam] = { embedded: embedded(p), missingFonts: j.missingFonts };
  }
  return res;
}

const mode = process.argv[2] || 'check';
const cur = measure();
if (mode === 'save') {
  fs.writeFileSync(BASE, JSON.stringify({ stamp: new Date().toISOString().slice(0, 10), host: require('node:os').hostname(), families: cur }, null, 1));
  console.log('BASELINE_SAVED ' + BASE + '  families=' + Object.keys(cur).length);
  process.exit(0);
}
if (!fs.existsSync(BASE)) { console.log('NO_BASELINE  先跑 node test/font-baseline.js save（要机主同意）'); process.exit(2); }
const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
const diffs = [];
for (const fam of Object.keys(base.families)) {
  const b = base.families[fam], c = cur[fam];
  const same = JSON.stringify(b.embedded) === JSON.stringify(c.embedded) && JSON.stringify(b.missingFonts) === JSON.stringify(c.missingFonts);
  if (!same) diffs.push({ fam, before: b, after: c });
}
console.log(JSON.stringify({ ok: diffs.length === 0, baselineStamp: base.stamp, compared: Object.keys(base.families).length, diffs }, null, 1));
process.exit(diffs.length ? 1 : 0);
