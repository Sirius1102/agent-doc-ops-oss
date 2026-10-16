// test/mutant.js — 变异台（判据有牙的自证装置，v1.0.0 起常驻）
// 用法：node test/mutant.js                 跑全部（每例只跑相关判据，见各例 only）
//       node test/mutant.js M3 M9          只跑指定几例
//       node test/mutant.js --list         列出每例：弄坏什么 / 只跑哪几条 / 应变红哪几条
// 设计要点（都是踩出来的）：
//  ① 每例带 `only`，用 `selftest --only=` 只跑相关判据 —— 否则 M9/M10 这类"把压缩包写坏"的变异
//     会让不相关的引擎调用一路卡到 60s 超时，整轮跑不完，台子会把"跑不完"误报成"没变红"。
//  ② 版本对账这类判据，变异要**弄坏数据**（把某个位置的版本号改掉），不能"把比较删掉"——
//     删掉比较后判据照样绿，什么也证明不了。
//  ③ 锚点必须唯一且命中；ANCHOR-MISS / ANCHOR-AMBIGUOUS 单列，不冒充红。
//  ④ 跑完逐字节还原 + md5 对账；被 SIGKILL 时靠 _tmp/mutant-bak-* 手工还原（迭代日志记过一次）。
//     🔴 前提假设（v3.0.1 审查轮补记）：所有被变异文件都是**普通文件**（本仓无符号链接）——若将来仓里出现
//     符号链接，还原步骤会写穿链接改到目标本体，md5 对账的"还原前后一致"就失效；那是新增前提，先补例再动仓。
//  ⑤ 跑前先**预检每例的 mustRed 能不能被自己的 only 选中**（v1.1.1 加）：M10 曾把 mustRed 写成
//     `scrub 原件零改动`，而 `only` 里没有能匹配它的 token —— 那不是"判据没牙"，是台子配错，
//     而它报出来的样子（未变红）和真没牙一模一样。消息类断言（红因原文里的词）走 `msg`，不参与预检。
const { spawnSync: cpSpawnSync } = require('node:child_process');
// spawn 统一包装（v2.2.3，与 dockit.js 同款）：stdin 钉 'ignore'——本会话宿主里缺省 stdio 的 spawnSync
// 稳定 EBUSY（详见 dockit.js 工具函数区注释）。台子要起大量 selftest 子进程，不钉这一下台子自己先跑不起来。
const SPAWN_STDIO_DEFAULT = ['ignore', 'pipe', 'pipe'];
function spawnSync(exe, args, opts) {
  const o = Object.assign({}, opts || {});
  if (!o.stdio) o.stdio = SPAWN_STDIO_DEFAULT;
  return cpSpawnSync(exe, args, o);
}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const D = 'dockit.js';
// 版本位锚点全部由 package.json 的当前版本派生：升版不用再回来改字符串
const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// 同理，文档里写的"内置判据 N 条"由源码定义点数派生（与 doc 卫生 判据同一把尺）：加判据不用再回来改这里
const JC = [...fs.readFileSync(path.join(ROOT, D), 'utf8').matchAll(/^[ \t]*(?:await[ \t]+)?(?:ta|t)\(\s*'[^']+'/gm)].length;
// 台子例数自算（与本文件自己的 { id: 'M…' } 同一条尺）：README 里那个数不许靠人记
const MJ = [...fs.readFileSync(__filename, 'utf8').matchAll(/\{ id: '(M\d+)'/g)].length;
// 语言白名单变异用的假名——用码点构造，源码里不留字面量，否则这个台子自己就先被 lang 判据判红
const KANA = String.fromCharCode(0x30a2);
// 🔴 v2.5.0：给所有子 selftest 注入 OFFICECLI 隔离两家（挡"活体触发"）——本仓 2026-10-13 第四次实测：
// 全量变异台里 M95（复现"探针漏 env"形状）的变体运行会真的原样触发后端自更新检查并下载替换（上游发新版时）。
// 把这两个变量放在**父环境**里后，即便被变异的那条路径漏设 env，子进程仍从父环境继承 SKIP_UPDATE——
// "活体下载替换"不再发生；M95 的牙不受影响（它的红来自源码级 env 断言，不来自运行副作用）。
const SAFE_BACKEND_ENV = { OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_RESIDENT: '1' };
// 🔴 v2.7.0（2026-10-14 实犯）：全量台跑到收尾还原那一次 writeFileSync 撞宿主文件锁
// （errno -4094 / code UNKNOWN，806 KB 的 dockit.js 上复现），异常抛穿 finally ⇒ **221 例结论随 stdout 一起丢了**。
// 两条分开修：① 写盘走有界重试（下面 writeHard），瞬时锁不再等于整轮报废；② **读数先打印、再去还原**，
// 锁最多弄脏还原面，不再吞结论。牙由判据「变异台写盘韧性与结论优先」三条子断言守（M224 拆重试、M225 把打印挪回还原之后）。
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const t = Date.now(); while (Date.now() - t < ms) { } } }
const LOCK_CODES = ['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN'];
function writeHard(p, buf, tag) {
  for (let i = 0; i < 8; i++) {
    try { fs.writeFileSync(p, buf); return true; }
    catch (e) {
      const code = String((e && e.code) || '');
      if (!LOCK_CODES.includes(code)) { console.error('🔴 ' + tag + ' 写回失败（非锁类，不重试）code=' + code + ' :: ' + p + ' :: ' + String(e && e.message).slice(0, 90)); return false; }
      if (i === 7) { console.error('🔴 ' + tag + ' 写回失败（重试 8 次仍是锁）code=' + code + ' :: ' + p); return false; }
      sleepMs(150 * (i + 1));
    }
  }
  return false;
}

const MUTANTS = [
  { id: 'M1', file: D, only: 'cap 能力矩阵,env doctor', name: '能力矩阵少一项（word 去掉 txt）', find: `word: { inputs: ['doc', 'docx', 'odt'], outputs: ['pdf', 'docx', 'odt', 'txt'] }`, to: `word: { inputs: ['doc', 'docx', 'odt'], outputs: ['pdf', 'docx', 'odt'] }`, mustRed: ['cap 能力矩阵与 kit 实测对账', 'env doctor 全绿'] },
  { id: 'M2', file: D, only: '装置 to 多表', name: '拆掉 to 的多表前置检查', find: `if (!flags.sheet && sh.method !== 'single' && sh.names.length > 1) die(`, to: `if (false && !flags.sheet && sh.method !== 'single' && sh.names.length > 1) die(`, mustRed: ['装置 to 多表出 csv 时前置拒绝'] },
  { id: 'M3', file: D, only: 'scrub', name: 'scrub 漏清 dc:creator（值仍留在源里）', find: `const CORE_RE = /<(dc:creator|`, to: `const CORE_RE = /<(zzz|`, mustRed: ['scrub --verify 转 PDF 后作者串零残留', 'scrub 双向自证', 'scrub 原件零改动'] },
  { id: 'M4', file: D, only: 'freePath', name: 'freePath 的去重序号从 1 起（承诺的 x-2/x-3 序列漂了）——🔴 v3.0.0 锚串随"existsSync 复核"改造第 3 次换靶（同一味攻击：起点改 1）', find: '  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}.${ext}`) && !fs.existsSync(`${dir}/${base}-${n}.${ext}`))', to: '  for (let n = 1; ; n += 1) if (!taken.has(`${base}-${n}.${ext}`) && !fs.existsSync(`${dir}/${base}-${n}.${ext}`))', mustRed: ['freePath 去重'] },
  { id: 'M5', file: D, only: '装置 sheets,sheet zip', name: 'sheets auto 跳过 zip 路线', find: `if (method !== 'render' && buf.readUInt32LE(0) === 0x04034b50) {`, to: `if (false && method !== 'render' && buf.readUInt32LE(0) === 0x04034b50) {`, mustRed: ['装置 sheets 会自报用了哪条枚举路线'] },
  { id: 'M6', file: D, only: 'pix,flag --pixels', name: '像素统计恒 0（假绿源头）', find: `if (cur[i] < 200 || cur[i + 1] < 200 || cur[Math.min(i + 2, stride - 1)] < 200) dark++;`, to: `if (cur[i] < -1) dark++;`, mustRed: ['pix 有字页非白像素 > 0', 'flag --pixels 默认给逐 tile 证据'] },
  { id: 'M7', file: D, only: 'codes', name: 'nextFor 不给处置文案', find: `case 'timeout': return \`文档很大或引擎冷启动慢；加 --timeout-ms（当前默认 \${DEFAULT_TIMEOUT_MS}）\`;`, to: `case 'timeout': return '';`, mustRed: ['codes 八种码族在装置里有处置文案'] },
  { id: 'M8', file: D, only: 'inspect', name: 'inspect 把整段元数据原文吐进回报（不截断）', find: `meta.push({ part, ...f });`, to: `meta.push({ part, ...f, raw: (() => { try { return String(zipRead(fs.readFileSync(input)).get(part)); } catch { return ''; } })() });`, mustRed: ['inspect 元数据只给字段名+长度'] },
  { id: 'M9', file: D, only: 'zip 自写包,scrub 的 roundTrip', blast: true, name: 'zipWrite 的**中央目录** CRC 写成 0（读者实际用那一项）', find: `ch.writeUInt32LE(crc, 16);`, to: `ch.writeUInt32LE(0, 16);`, mustRed: ['zip 自写包坏在明处会被抓：中央目录 CRC 被抹必须抛错', 'scrub 的 roundTrip 自证在位'], msg: ['中央=0'] },
  { id: 'M10', file: D, only: 'zip 自写包,inspect,scrub 的 roundTrip,scrub 原件零改动', blast: true, name: 'zipRead 对 deflate 条目不解压（读回原始压缩字节）', find: `if (method === 8) data = zlib.inflateRawSync(raw);`, to: `if (method === 8) data = raw;`, mustRed: ['inspect 声明字体族里能看到故意族', 'scrub 原件零改动'] },
  { id: 'M11', file: 'package.json', only: 'v1 版本号', name: 'package.json 的版本位写错', find: `"version": "${V}"`, to: `"version": "9.9.9"`, mustRed: ['v1 版本号五处一致'] },
  { id: 'M12', file: '项目总览.md', only: 'v1 版本号', name: '项目总览页眉的版本位没跟上', find: `版本 v${V} ｜ 更新日期`, to: `版本 v9.9.9 ｜ 更新日期`, mustRed: ['v1 版本号五处一致'] },
  { id: 'M13', file: 'README.md', only: 'v1 版本号', name: 'README 的版本位没跟上', find: `版本 v${V} ｜ 权威文档`, to: `版本 v9.9.9 ｜ 权威文档`, mustRed: ['v1 版本号五处一致'] },
  { id: 'M14', file: '给其它agent-调用卡.md', only: 'v1 版本号', name: '调用卡的版本位没跟上', find: `**版本**：v${V}（`, to: `**版本**：v9.9.9（`, mustRed: ['v1 版本号五处一致'] },
  { id: 'M15', file: D, only: 'v1 版本号', name: '本文件头注释的版本位与 VERSION 常量不一致', find: ` * 版本：v${V}（`, to: ` * 版本：v9.9.9（`, mustRed: ['v1 版本号五处一致'] },
  { id: 'M16', file: D, only: 'cli 兜异常', name: '入口区把兜住的异常重新抛出（等于裸栈直出）', find: `try { return COMMANDS[cmd](rest); } catch (e) {`, to: `try { return COMMANDS[cmd](rest); } catch (e) { if (1) throw e;`, mustRed: ['cli 兜异常'] },
  { id: 'M17', file: D, only: '同一个假值', name: '拆掉"逐条实算 CRC vs 记录值"那一层对账（打架层留着，专测重算层有没有独立牙）', find: `if (got !== crc) throw new Error(`, to: `if (false && got !== crc) throw new Error(`, mustRed: ['zip 自写包坏在明处会被抓：局部+中央 CRC 同一个假值时逐条重算必须抛错'] },
  // M18/M19 各打 v1.1.3 新判据「doc 卫生」的一层：路径存在性 / 控制字符。两层必须能分开红（M9 与 M17 的教训）。
  { id: 'M18', file: 'README.md', only: 'doc 卫生', name: '破坏公开仓库路径占位调用示例（文档卫生检查必须发现入口示例缺失）', find: 'node <REPO>\\dockit.js <命令> [参数...]', to: 'node <BROKEN-REPO>\\dockit.js <命令> [参数...]', mustRed: ['doc 卫生'] },
  { id: 'M19', file: 'README.md', only: 'doc 卫生', name: '往 README 标题前注入控制字符（专打"反斜杠转义被脚本吞掉"那一层，路径与条数都不动）', find: `## 一行调用`, to: `\u0007## 一行调用`, mustRed: ['doc 卫生'] },
  { id: 'M20', file: 'README.md', only: 'doc 卫生', name: '把 README 写的内置判据条数改成实际值 +1（专打"条数靠人记"那一层；README 的数字没跟上时本例会先报 ANCHOR-MISS）', find: `判据条数=${JC}`, to: `判据条数=${JC + 1}`, mustRed: ['doc 卫生'] },
  // M21–M23 是 v1.2.0 补的三条：台子例数、语言白名单、异步失败出口——前两条各打 doc 卫生/lang 的一层，第三条打那条一直没有覆盖的出口。
  { id: 'M21', file: 'README.md', only: 'doc 卫生', name: '把 README 写的变异台例数改成实际值 +1（专打"台子例数靠人记"那一层）', find: `变异例数=${MJ}`, to: `变异例数=${MJ + 1}`, mustRed: ['doc 卫生'] },
  { id: 'M22', file: 'README.md', only: 'lang 语言白名单', name: '往 README 标题前注入一个片假名（总纲第二节语言白名单；假名由码点构造，源码不留字面量）', find: `## 一行调用`, to: `${KANA}## 一行调用`, mustRed: ['lang 语言白名单'] },
  { id: 'M23', file: D, only: 'cli 异步出口', name: '把异步失败出口的 next 文案退回"看 stderr"（与装置输出契约相反的那句，v1.1.1 已在规范里订正过）', find: `next: '把本行 JSON 原样回报给调用方，不要重试；装置的成功与失败都是 stdout 上的一份 JSON，判成败只看 ok 字段与退出码'`, to: `next: '看 stderr'`, mustRed: ['cli 异步出口'] },
  // M24/M25 打 v1.2.0 两条新判据各自那一层（取证 ODF 时抓到的两个真缺陷：实体没解、ODF 走错码）。
  { id: 'M24', file: D, only: '已解 XML 实体', name: '短路 xmlUnesc（把实体原样吐给调用方）', find: `function xmlUnesc(s) {`, to: `function xmlUnesc(s) { return String(s);`, mustRed: ['inspect 声明字体族必须已解 XML 实体'] },
  { id: 'M25', file: D, only: 'scrub 的容器分流', name: '拆掉 scrub 的双族分流守卫（裸 ZIP 就会落到"没有可清"那一支，把"不支持"再次报成"你没东西可清"——v1.2.0 那个方向错误，R3-a 之后仍不许复发）', find: `if (!isOOXMLFam && !isODFFam) die(`, to: `if (false && !isOOXMLFam && !isODFFam) die(`, mustRed: ['scrub 的容器分流'] },
  // M26/M27/M28 打 v1.2.1 采集面修复的**三层各自那一层**（总览第八节第 11 条与规范 §4.4 第 7 条要求：
  // 一条能力若由多层守，每层都要能被单独打红，否则第二层的"有牙"只是同一声响的回声）。
  { id: 'M26', file: D, only: '字体族采集面', name: '部件清单退回 v1.2.1 前（不读 theme/slideMaster/slideLayout/fontTable/sharedStrings）', find: `|theme\\d+|slideMaster\\d+|slideLayout\\d+|fontTable|sharedStrings`, to: ``, mustRed: ['inspect OOXML 字体族采集面'] },
  { id: 'M27', file: D, only: '字体族采集面', name: '拆掉 typeface= 这一族名抽取路线（theme 与版式件里的真族名读不到）', find: `for (const m of xml.matchAll(/typeface\\s*=\\s*"([^"]{1,64})"/g)) add(m[1]);`, to: `for (const m of xml.matchAll(/xxNEVERMATCHtypeface\\s*=\\s*"([^"]{1,64})"/g)) add(m[1]);`, mustRed: ['inspect OOXML 字体族采集面'] },
  { id: 'M28', file: D, only: '字体族采集面', name: '拆掉主题令牌过滤（+mj-lt / +mn-lt 被当成族名 ⇒ 缺字方向假阳性）', find: `if (!v || v === 'default' || v.startsWith('+')) return;`, to: `if (!v || v === 'default') return;`, mustRed: ['inspect OOXML 字体族采集面'] },
  // M29 打 v1.3.0 A 段新判据「entry 登记表」：登记表是数据文件，路径靠人记一定烂——
  // 把其中一条落盘入口的路径末位写错一号（SKILL.md → SKILL.me），必须只红这一条（与 M18 打 doc 卫生 存在性层同形状）。
  // 🔴 R5（v1.6.0）把锚点加宽了：`agent-doc-ops\\SKILL.md` 原本只命中 1 行，五家落盘后命中 5 行 ⇒ ANCHOR-AMBIGUOUS 拒跑。
  // 这是"新代码把旧变异锚点挤歧义"的**第三次**（前两次：M70 的 cmdDump 复制行、M49 的 verify lang 规格行），检查项照旧：改动登记表或复制整行代码后立刻全量跑台子。
  { id: 'M29', file: 'entry-points.json', only: 'entry 登记表', name: '把登记表里 Qoder CN 那条入口路径末位写错一号（专打"登记表路径没人核"那一层）', find: `qoder-cn\\\\skills\\\\agent-doc-ops\\\\SKILL.md`, to: `qoder-cn\\\\skills\\\\agent-doc-ops\\\\SKILL.me`, mustRed: ['entry 登记表'] },
  // M30 打 v1.3.1 recalc-OLE 修复的那一层（B 段真件撞出的缺陷）：拆掉 --verify 的 OLE 前置守卫，
  // 假 OLE 夹具就会穿透到引擎并被兜底层裹成 invalid-document ⇒ 判据必须红（与 M25 打 scrub-ODF 分流同形状）。
  { id: 'M30', file: D, only: '对非 ZIP', name: '拆掉 recalc --verify 的 OLE 前置守卫（退回炸成 invalid-document 说"装置内部异常"）', find: `if (flags.verify) { const hb = fs.readFileSync(input); if (hb.length < 4 || hb.readUInt32LE(0) !== 0x04034b50) die(`, to: `if (flags.verify && false) { const hb = fs.readFileSync(input); if (hb.length < 4 || hb.readUInt32LE(0) !== 0x04034b50) die(`, mustRed: ['对非 ZIP'] },
  // M31/M32/M33 打 v1.4.0 ocr 子命令的各层（ADR-001 引入 Tesseract；任务书 G §2.5：
  // 降级形状/正向出字/空白正面控制/自曝齐全——每层配一次能单独打红它的变异，不许搭便车）。
  { id: 'M31', file: D, only: 'ocr 降级', name: '拆掉 ocr 的 tesseract 在位守卫（缺引擎时应 unavailable＋指路，却一路撞到 spawn 报 failed）', find: `if (!probe.available) die('unavailable', probe.why, ocrNextUnavailable());`, to: `if (false && !probe.available) die('unavailable', probe.why, ocrNextUnavailable());`, mustRed: ['ocr 降级'] },
  { id: 'M32', file: D, only: 'ocr 空白样张', name: '拆掉 ocr 逐行计数的空白行过滤（空白图会数出幻影行）', find: "const lines = txt.split(/\\r?\\n/).filter((l) => l.trim() !== '');", to: "const lines = txt.split(/\\r?\\n/);", mustRed: ['ocr 空白样张'] },
  { id: 'M33', file: D, only: 'ocr 自曝', name: '抹掉 ocr 输出的 backend 自曝（引擎版本不见即红，不许静默降级成无引擎信息）', find: 'backend: probe.version,', to: '', mustRed: ['ocr 自曝'] },
  { id: 'M34', file: D, only: 'ocr 合成图', name: '把 ocr 自报的 txt 路径指向不存在的落点（自曝路径与实际产物不一致，沿自报路径取文必须红）', find: "const txtPath = `${outBase}.txt`;", to: "const txtPath = `${outBase}.txt.wrong`;", mustRed: ['ocr 合成图'] },
  // M35 打 v1.4.1 补的那一层：ocr 自报的 langPack 与"本次实际所用的 tessdata 目录"解耦——
  // 走 --tessdata-dir 时同一条 JSON 里两个字段互相矛盾（监工侧实测撞出，M33 那种"字段缺失即红"抓不到它，
  // 因为字段一直有值，只是值说的是别的目录）。靶只有第 73 条判据的覆盖目录条款。
  { id: 'M35', file: D, only: 'ocr 自曝', name: '把 ocr 的 langPack 退回"恒取默认 tessdata 基名"（换 --tessdata-dir 时与自报 tessdataDir 矛盾）', find: 'langPack: path.basename(tessdataDir),', to: 'langPack: probe.langPack,', mustRed: ['ocr 自曝'], msg: ['langPack 没跟着 --tessdata-dir 变'] },
  // M36 打 v1.5.0 那一层：语言清单按"默认/env 目录"报，而不是按本次真用的目录报。
  // 与 M35 同一判据、不同层（M35＝目录名，M36＝目录内容清单），各配一次独立攻击（§4.4 第 ⑦ 条不许搭便车）。
  { id: 'M36', file: D, only: 'ocr 自曝', name: '把 ocr 自报的语言清单退回"读默认 tessdata 目录"（覆盖目录只有一份 eng.traineddata 却报出默认那套 eng+osd 两种）', find: 'langCount: eff.langCount, langs: eff.langs,', to: 'langCount: probe.langCount, langs: probe.langs,', mustRed: ['ocr 自曝'], msg: ['语言清单不是本次覆盖目录的'] },
  // M42 + M49–M54 打 v1.6.0 R1-a（help 结构化命令面）。编号按《方案》§3 的分配：M37–M41 留给 R2/R3 批次，
  // 这里先占 R1-a 自己那一条（M42），其余按"续号 M37+"的口径从 M49 起排——判据的每一层都要有能单独打红它的攻击。
  { id: 'M42', file: D, only: '结构化命令面', name: '改配置区的超时默认值、不动 help（专打"help 报的默认值 == 配置区当前值"这一层）', find: `const DEFAULT_TIMEOUT_MS = 120000;`, to: `const DEFAULT_TIMEOUT_MS = 60000;`, mustRed: ['help 结构化命令面'] },
  { id: 'M49', file: D, only: '结构化命令面', name: '把 help 的默认值从字面量改成引用常量（这一改让默认值对账恒真＝假牙形状，只有结构条款拦得住）', find: `{ name: 'lang', type: 'string', default: 'eng', defaultFrom: 'OCR_DEFAULT_LANG', note: '中文要 chi_sim；缺语言包时 tesseract 自身报错，装置映射为 unsupported-format 并指路'`, to: `{ name: 'lang', type: 'string', default: OCR_DEFAULT_LANG, defaultFrom: 'OCR_DEFAULT_LANG', note: '中文要 chi_sim；缺语言包时 tesseract 自身报错，装置映射为 unsupported-format 并指路'`, mustRed: ['help 结构化命令面'] },
  { id: 'M50', file: D, only: '结构化命令面', name: '把 inspect 的 --deep 宣告改成代码里不存在的名字（宣告的没读、读的没宣告，两面同时漂）', find: `{ name: 'deep', type: 'boolean', default: false,`, to: `{ name: 'deepx', type: 'boolean', default: false,`, mustRed: ['help 结构化命令面'] },
  { id: 'M51', file: D, only: '结构化命令面', name: '抹掉 to 的 --sheet 那条 null 默认的 defaultNote（"不传时谁定"没交代，省略字段不算交代）', find: `default: null, defaultNote: '多表工作簿出 csv 时**必填**（先 sheets 拿准确表名，装置会前置拒绝并列出可选表名）'`, to: `default: null`, mustRed: ['help 结构化命令面'] },
  { id: 'M52', file: D, only: '结构化命令面', name: 'HELP 表里的 help 条目名字歪一号（三面同名条款：COMMANDS / HELP / HELP_SPEC 少一个就对不上）', find: `  help: 'help：命令清单',`, to: `  he1p: 'help：命令清单',`, mustRed: ['help 结构化命令面'] },
  { id: 'M53', file: D, only: '单命令详询', name: '命令分发退回按 COMMANDS[cmd] 判存在（原型链成员被当成命令：toString 不出 JSON 静默退 0）', find: `!Object.prototype.hasOwnProperty.call(COMMANDS, cmd)`, to: `!COMMANDS[cmd]`, mustRed: ['help 单命令详询走 CLI'] },
  { id: 'M54', file: D, only: '单命令详询', name: '布尔开关名单退回写死的那三份（--deep 放到末位又必死"缺值"，即 R1-a 的起因）', find: `const bools = new Set(spec ? spec.flags.filter((f) => f.type === 'boolean').map((f) => f.name) : []);`, to: `const bools = new Set(['verify', 'all-lines', 'quiet']);`, mustRed: ['help 单命令详询走 CLI'] },
  // 🔴 曾想加 M55（拆掉 `--key=值` 的内联赋值）打 J2 的覆盖面③，**没收进常驻台子**：台子自己就是用
  // `selftest --only=<名>` 调判据的，破坏内联形状的变异会让**每一例**都跑不起来（实测 ran=0、报 BAD 而非红），
  // 那是击穿台子而不是打红判据。改为一次性人工证红并留档（见迭代日志 v1.6.0 R1-a 条）：
  // 把该行改成 `const inline = null;` 后全量 selftest 出 `FAIL help 单命令详询走 CLI :: --method=zip 没走通`，随后 cp+md5 还原。
  // M43 + M56–M59 打 v1.6.0 R1-b（最近邻候选与未知开关拒绝）：函数层与入口接线层分开，各配独立攻击。
  { id: 'M43', file: D, only: '最近邻候选', name: '让候选恒为空（差多远都荐不出东西，"给最近邻"这条能力名义上还在、实际死了）', find: `.filter((x) => x.d <= tol)`, to: `.filter(() => false)`, mustRed: ['最近邻候选'] },
  { id: 'M56', file: D, only: '最近邻候选', name: '拆掉"正确名早退"（用对了也回候选＝调用方很快学会无视这个字段）', find: `if (!key || pool.includes(name)) return [];`, to: `if (!key) return [];`, mustRed: ['最近邻候选'] },
  { id: 'M57', file: D, only: '带 candidates', name: '拆掉 parseArgs 的未知开关拒绝（退回"错拼被静默吃掉、命令照常成功"）', find: `if (spec && !spec.flags.some((f) => f.name === key) && !GLOBAL_FLAGS.includes(key)) {`, to: `if (false && spec && !spec.flags.some((f) => f.name === key) && !GLOBAL_FLAGS.includes(key)) {`, mustRed: ['未知开关与未知命令走 CLI'] },
  { id: 'M58', file: D, only: 'candidates', name: 'doctor 退回不吃参数（于是 `doctor --banana` 静默跑完整轮体检）', find: `parseArgs(args || [], 'doctor');`, to: `;`, mustRed: ['未知开关与未知命令走 CLI'] },
  { id: 'M59', file: D, only: '带 candidates', name: '命令分发的候选写死为空数组（未知命令仍失败，但不再指路）', find: `const cand = nearestCandidates(cmd || '', Object.keys(COMMANDS));`, to: `const cand = [];`, mustRed: ['未知开关与未知命令走 CLI'] },
  // M60–M64 打 v1.6.0 R1-c（ADR-001 的 Python 事实订正句）：页眉修订位、定性短语、活查读数三层各自能打红。
  { id: 'M60', file: 'docs/adr/ADR-001-tesseract-ocr-外部依赖.md', only: 'ADR-001 订正句', name: '抹掉订正句的带日期标记（订正事实还在，但没人知道它是哪天、按什么口径改的）', find: '**【2026-10-06 订正，任务书 H R1-c', to: '**【订正，任务书 H R1-c', mustRed: ['doc ADR-001 订正句'] },
  { id: 'M61', file: 'docs/adr/ADR-001-tesseract-ocr-外部依赖.md', only: 'ADR-001 订正句', name: '把 ADR 记的 Python 版本号改一位（活查那层的独立牙：定性短语全都还在）', find: '`Python 3.14.3`', to: '`Python 3.14.4`', mustRed: ['doc ADR-001 订正句'] },
  { id: 'M62', file: 'docs/adr/ADR-001-tesseract-ocr-外部依赖.md', only: 'ADR-001 订正句', name: '把 ADR 记的 python.exe 字节数改一号（同一层的另一面：记的数字必须还能现算）', find: '文件 605,016 B', to: '文件 605,017 B', mustRed: ['doc ADR-001 订正句'] },
  { id: 'M63', file: 'docs/adr/ADR-001-tesseract-ocr-外部依赖.md', only: 'doc 卫生', name: '往 ADR 标题前注入控制字符（这一轮把卫生扫描面扩到 docs/adr/，不扩就没人管这份文件里的 0x0C 形状）', find: '## 一、背景', to: '\u0007## 一、背景', mustRed: ['doc 卫生'] },
  { id: 'M64', file: 'docs/adr/ADR-001-tesseract-ocr-外部依赖.md', only: 'ADR-001 订正句', name: '页眉修订行的键名改写成别的写法（机器形状一坏，订正痕迹就从可查变成不可查）', find: '- 修订：v1.6.0（2026-10-06）', to: '- 修订记录：v1.6.0（2026-10-06）', mustRed: ['doc ADR-001 订正句'] },
  // M38 + M65–M70 打 v1.6.0 R2-a（check 纯 ZIP 体检）：五族规则各一层，加"不起引擎/不写盘"的源码层断言与 OLE 前置守卫层。
  { id: 'M38', file: D, only: 'check 体检', name: '把缺替代文字写成"有 docPr 就算过"（descr 只填空格也被放过——《方案》点名的那条变异）', find: `      if (!(dm && dm[1].trim())) add('missing-alt-text',`, to: `      if (false && !(dm && dm[1].trim())) add('missing-alt-text',`, mustRed: ['check 体检'] },
  { id: 'M65', file: D, only: 'check 体检', name: '公式错误值缓存恒跳过（t="e" 与 #REF! 两种入口一起瞎掉）', find: `        if (!isErrType && !isErrValue) continue;`, to: `        if (true) continue;`, mustRed: ['check 体检'] },
  { id: 'M66', file: D, only: 'check 体检', name: '空表判反（有单元格的才算空——条数一样，只有 locator 断言看得见）', find: `      if (!/<c\\s/.test(str(data))) add('empty-sheet',`, to: `      if (/<c\\s/.test(str(data))) add('empty-sheet',`, mustRed: ['check 体检'] },
  { id: 'M67', file: D, only: 'check 体检', name: 'meta-field 把字段值原文带进回报（承重 3 的不回显破口：条数不变，只有夹具秘密串能抓）', find: "（值 ${Buffer.byteLength(m[1].trim(), 'utf8')} B，不回显）——外发前走 scrub --verify", to: "（值 ${m[1].trim()}，不回显）——外发前走 scrub --verify", mustRed: ['check 体检'] },
  { id: 'M68', file: D, only: 'OLE 输入前置', name: '拆掉 check 的 OLE 前置守卫（退回被 zipRead 异常裹成 invalid-document，把不支持报成你文件坏了）', find: `  if (buf.readUInt32LE(0) !== 0x04034b50) die('unsupported-format', 'check 吃 ZIP 系容器（docx/xlsx/pptx/odt/ods/odp）与 PDF`, to: `  if (false && buf.readUInt32LE(0) !== 0x04034b50) die('unsupported-format', 'check 吃 ZIP 系容器（docx/xlsx/pptx/odt/ods/odp）与 PDF`, mustRed: ['OLE 输入前置 unsupported-format'] },
  { id: 'M69', file: D, only: 'check 体检', name: '过滤态也自称 clean（被 --kind 滤出来的 0 项不等于全查干净——两个字段之间的关系写错）', find: `  const totalConclusions = findings.length;\n  const clean = totalConclusions === 0 && !filter;`, to: `  const totalConclusions = findings.length;\n  const clean = totalConclusions === 0;`, mustRed: ['check 体检'] },
  { id: 'M70', file: D, only: 'OLE 输入前置', name: '往 check 里塞一次引擎调用（纯 ZIP 不起引擎是这一条的卖点，加了就名实不符）——锚点带上下一句，因为 dump 里也有同一行 zipFamily', find: `  const container = zipFamily(map);
  if (!container) die('invalid-document', 'ZIP 里找不到 OOXML/ODF 的标志部件，认不出容器', '先 inspect 看容器识别结果；纯文本`, to: `  runKit(['capabilities']); const container = zipFamily(map);
  if (!container) die('invalid-document', 'ZIP 里找不到 OOXML/ODF 的标志部件，认不出容器', '先 inspect 看容器识别结果；纯文本`, mustRed: ['OLE 输入前置 unsupported-format'] },
  // M37 + M71–M74 打 v1.6.0 R2-b（dump 默认只出形状）：默认回显、两条上限、部件方法、元数据不给值，各一层。
  { id: 'M37', file: D, only: '只出形状', name: '让 dump 恒当作带了 --text（默认就把正文吐给调用方——《方案》点名的那条变异）', find: `const wantText = flags.text === true;`, to: `const wantText = true;`, mustRed: ['dump 默认只出形状'] },
  { id: 'M71', file: D, only: '上限与截断', name: '拆掉正文条目上限（一次 dump 能把整本书灌进 JSON，且不再自报截断）', find: `        if (entries.length >= DUMP_TEXT_MAX_ITEMS) { textTruncated = true; break; }`, to: `        if (false && entries.length >= DUMP_TEXT_MAX_ITEMS) { textTruncated = true; break; }`, mustRed: ['dump 的上限与截断'] },
  { id: 'M72', file: D, only: '上限与截断', name: '拆掉扫描体积上限（超体积的部件不再被点名 skipped，而是静默扫下去）', find: `    if (data.length > DUMP_SCAN_MAX_BYTES) { shapes.push(`, to: `    if (false && data.length > DUMP_SCAN_MAX_BYTES) { shapes.push(`, mustRed: ['dump 的上限与截断'] },
  { id: 'M73', file: D, only: '只出形状', name: '部件清单丢掉压缩方法（R3-a 那条 mimetype 必须 stored 的缺陷就再也看不见）', find: `parts.push({ order: r.order, name: r.name, method: r.methodLabel,`, to: `parts.push({ order: r.order, name: r.name, `, mustRed: ['dump 默认只出形状'] },
    { id: 'M74', file: D, only: '只出形状', name: 'shapes 里顺手把部件原文截一段带出来（inspect 的 M8 同族：默认形状面一旦带上原文，作者名就跟着出域）', find: `    shapes.push({ part: r.name, isMetaPart: META_PARTS.includes(r.name), elementKinds: tags.size,`, to: `    shapes.push({ part: r.name, raw: xml.slice(0, 240), isMetaPart: META_PARTS.includes(r.name), elementKinds: tags.size,`, mustRed: ['dump 默认只出形状'] },
  // M39/M40/M41/M75/M76 打 v1.6.0 R3-a（zipWrite per-entry method + scrub 的 ODF 面）。
  { id: 'M39', file: D, only: 'scrub 的 ODF 面', name: '从共享清单里漏掉 meta:generator 一项（探针与删除同源，判据里那份独立清单必须发现少了一个）', find: `const ODF_META_FIELDS = ['meta:initial-creator', 'dc:creator', 'dc:title', 'dc:subject', 'dc:description', 'meta:generator'`, to: `const ODF_META_FIELDS = ['meta:initial-creator', 'dc:creator', 'dc:title', 'dc:subject', 'dc:description'`, mustRed: ['scrub 的 ODF 面'] },
  { id: 'M40', file: D, only: 'scrub 的 ODF 面', name: '缩略图不删（Thumbnails/thumbnail.png 是第一页的渲染图，留着就是版面内容跟着外发件出门）', find: `for (const t of ODF_THUMBNAIL_PARTS) if (map.has(t)) { map.delete(t); removedEntries.push(t); }`, to: `for (const t of ODF_THUMBNAIL_PARTS) if (false && map.has(t)) { map.delete(t); removedEntries.push(t); }`, mustRed: ['scrub 的 ODF 面'] },
  { id: 'M41', file: D, only: 'scrub 的 ODF 面', name: '回写时把每个条目都按 deflate 写（ODF 规范要 mimetype 首位 stored；本机引擎实测**不拒**这种包，所以这层钉的是规范形状而不是报错，见迭代日志取证）', find: `  const entries = [...map.entries()].map(([name, data]) => ({ name, data, method: methOf[name] === 0 ? 0 : 8 }));`, to: `  const entries = [...map.entries()].map(([name, data]) => ({ name, data, method: 8 }));`, mustRed: ['scrub 的 ODF 面'] },
  { id: 'M75', file: D, only: 'zipWrite 逐条目 method', name: '非法 method 不再拒（点名 9 却静默按 deflate 写，等于把调用方的要求吃掉）', find: `if (method !== 0 && method !== 8) throw new Error(`, to: `if (false && method !== 0 && method !== 8) throw new Error(`, mustRed: ['zipWrite 逐条目 method'] },
  { id: 'M76', file: D, only: 'zipWrite 逐条目 method', name: 'stored 分支不存原文、照样 deflate（头部写着 stored，读者不解压就拿到压缩字节）', find: `const comp = method === 0 ? Buffer.from(data) : zlib.deflateRawSync(data, { level: 9 });`, to: `const comp = zlib.deflateRawSync(data, { level: 9 });`, mustRed: ['zipWrite 逐条目 method'] },
  // M77–M81 打 v1.6.0 R3-b（字符集基线台子）：报数自洽、覆盖闸门、成员判定、扫描面、消失集，各一层。
  { id: 'M77', file: 'test/char-baseline.js', only: '字符集基线', name: 'check 把实算码点数报多一个（实算=基线+新增−消失这条算术当场不自洽；旧写法是"基线数报成实算数"，只在真有漂移时才红＝条件牙，本轮全量跑复现 BAD 后换掉）——🔴 v2.10.0 锚串跟着 --at 改造换靶（b.set → bUse.set），攻击本身一模一样', find: `基线码点数: bUse.set.size, 实算码点数: all.size,`, to: `基线码点数: bUse.set.size, 实算码点数: all.size + 1,`, mustRed: ['字符集基线台子'] },
  { id: 'M78', file: 'test/char-baseline.js', only: '字符集基线', name: '拆掉 save 的同意闸门（谁都能把漂移的基线覆盖掉＝为了让台子绿而扩集合）', find: `if (process.env.DOCKIT_BASELINE_CONSENT !== '1') {`, to: `if (false && process.env.DOCKIT_BASELINE_CONSENT !== '1') {`, mustRed: ['字符集基线台子'] },
  { id: 'M79', file: 'test/char-baseline.js', only: '字符集基线', name: 'explain 的成员判定恒真（基线外汉字也说"在基线内"⇒ 注入对照与反向对照同时失去意义）', find: `在基线内: !!b && b.set.has(cp)`, to: `在基线内: true`, mustRed: ['字符集基线台子'] },
  { id: 'M80', file: 'test/char-baseline.js', only: '字符集基线', name: '扫描面清空（台子扫不到装置的 LANG_FILES，两处一把尺断开）', find: `return [...new Set([...langFiles(), ...EXTRA, ...adrs])].filter((rel) => fs.existsSync(path.join(ROOT, rel)));`, to: `return [...new Set([...langFiles(), ...EXTRA, ...adrs])].filter(() => false);`, mustRed: ['字符集基线台子'] },
  { id: 'M81', file: 'test/char-baseline.js', only: '字符集基线', name: '消失集算错（把整个基线都当成消失，实算=基线+新增−消失这条算术当场不自洽）——🔴 v2.10.0 锚串跟着 --at 改造换靶（b → bUse），攻击本身一模一样；与 M255（恒空）是同一面的两个方向', find: `const gone = [...bUse.set].filter((cp) => !all.has(cp)).sort((x, y) => x - y);`, to: `const gone = [...bUse.set].sort((x, y) => x - y);`, mustRed: ['字符集基线台子'] },
  // M44/M45 + M83–M85 打 v1.6.0 R4-a（verify 两条取字路线对账）：算出来的覆盖率、幻影方向、missing 判定、降级与半条模式各一层。
  { id: 'M44', file: D, only: 'verify 正向', name: '覆盖率恒报 1.0（《方案》点名的变异：正向夹具照样绿，只有"必须有一例读不出"的反面对照能抓它）', find: `const coverage = mode === 'both' ? (aTotal ? +((aTotal - missingIdx.length) / aTotal).toFixed(5) : 1) : null;`, to: `const coverage = mode === 'both' ? 1 : null;`, mustRed: ['verify 正向'] },
  { id: 'M45', file: D, only: 'verify 正向', name: '幻影清单从 A 侧长度算（v1.0.0 事故 1 同族：把"OCR 多出来的行"和"文本层的行"混成一回事）', find: `phantom: bNorm.length - matchedInA.length,`, to: `phantom: aBlob.length - matchedInA.length,`, mustRed: ['verify 正向'] },
  { id: 'M83', file: D, only: 'verify 反向有牙', name: 'missing 判定短路（文本层有、渲染层读不出的字形缺口永远不被点名 ⇒ verify 白跑）', find: `if (r < 1) { missingIdx.push(i + 1); missingRatio.push(r); }`, to: `if (false && r < 1) { missingIdx.push(i + 1); missingRatio.push(r); }`, mustRed: ['verify 反向有牙'] },
  { id: 'M84', file: D, only: '半条与降级', name: '拆掉 verify 的 tesseract 在位守卫（缺引擎时半跑半成、甚至跑完不报降级）', find: `if (!probe.available) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} die('unavailable', probe.why, ocrNextUnavailable()); }`, to: `if (false && !probe.available) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} die('unavailable', probe.why, ocrNextUnavailable()); }`, mustRed: ['半条与降级'] },
  { id: 'M85', file: D, only: '半条与降级', name: '拆掉扫描件"空文本层退回 render-only"守卫（扫描件被谎报成 mode=both）', find: `if (aLines.length === 0) {
      mode = 'render-only';`, to: `if (false) {
      mode = 'render-only';`, mustRed: ['半条与降级'] },
  // M46/M86–M88 打 v1.6.0 R4-b（factcheck 时点事实）：列义、计数判定、豁免范围、行数口径各一层。
  { id: 'M46', file: D, only: 'factcheck 时点事实', name: '把 rev-list 的左右列写反（左列是"只在 upstream 有的提交"＝落后，写成领先就是本轮自己差点犯的那类错）', find: `live.behind = m[0]; live.ahead = m[1];`, to: `live.behind = m[1]; live.ahead = m[0];`, mustRed: ['factcheck 时点事实'] },
  { id: 'M86', file: D, only: 'factcheck 时点事实', name: '时点计数恒判对（假样本②当场不红 ⇒ 整条命令变成装饰）', find: `verdict: v === val ? 'ok' : 'mismatch',`, to: `verdict: 'ok',`, mustRed: ['factcheck 时点事实'] },
  { id: 'M87', file: D, only: 'factcheck 时点事实', name: '日志豁免扩大到语义类（列义写反藏在日志里就查不出了——豁免只该管"引用旧数字"）', find: `if (f.kind !== '时点计数' && f.kind !== '行数口径' && f.kind !== '行号引用') continue;`, to: ``, mustRed: ['factcheck 时点事实'] },
  { id: 'M88', file: D, only: 'factcheck 时点事实', name: '编辑器行数口径算成与 wc -l 相同（末行无换行的文件两种口径不等，这层就永远报不出 ambiguous）', find: `const editor = nl + (b.length && b[b.length - 1] !== 0x0a ? 1 : 0);`, to: `const editor = nl;`, mustRed: ['factcheck 时点事实'] },
  // M89/M90 打 v1.6.0 R5（登记表字段互不矛盾）的两个方向：一条改"有路径却说不落盘"，一条改"没路径却说已落盘"。
  // 分开打是必须的——判据里这两个分支是反向蕴含，只攻一个方向时另一个方向的代码可以整块删掉而无人喊疼（同形双分支，各自钉唯一后继）。
  { id: 'M89', file: 'entry-points.json', only: '登记表字段互不矛盾', name: '把 ZCode 那行的状态改回"未落盘"（它其实登记着母本卡路径 ⇒ 字段互相打脸，路径存在性判据看不见这层）', find: `"状态": "已活验（按调用卡 §2 实跑 doctor，JSON 原值见 A 段交付回报）"`, to: `"状态": "未落盘（本轮未放行）"`, mustRed: ['登记表字段互不矛盾'], msg: ['ZCode'] },
  { id: 'M90', file: 'entry-points.json', only: '登记表字段互不矛盾', name: '把 WorkBuddy（路径为 null）的状态写成"已落盘"（反向蕴含：不许对着没落盘的家声称已落/已活验）', find: `"状态": "未落盘（写入涉及既有 persona 文件，等单独授权）"`, to: `"状态": "已落盘（persona 文件族，2026-10-06）"`, mustRed: ['登记表字段互不矛盾'], msg: ['WorkBuddy'] },
  // M91–M94 打 v1.6.0 R0-b（ADR-002 在册）。四条各攻一层，且 M93 专门用来证明这条判据没犯"全文出现即算过"：
  // `refresh` 在 ADR 里出现 6 次，只有把**排除项 A 那一行**里的它抹掉才该红——行级锚定不是修辞。
  { id: 'M91', file: 'docs/adr/ADR-002-officecli-写操作后端.md', only: 'ADR-002', name: '改掉"三、决策"的行首标题（四段缺一；R6 的准入条件全在第三段）', find: `## 三、决策`, to: `## 三、决定`, mustRed: ['ADR-002'] },
  (() => {
    // M92 的靶改成按**当下在位件实算**定位（v1.6.7 监工侧改法）。实犯：原来写死 1.0.154 那枚 sha，
    // 后端 10-07 漂到 155 之后，「把 154 的末位改错一号」不再让 实算∉登记枚集 成立 ⇒ M92 静默失去靶却仍报 OK。
    // 漂移态（在位件没登记）时 `doc ADR-002 在册` 本就红 ⇒ 新的基线预检会把本例判 BASELINE-RED：说不出话是正确结论。
    const exe = process.env.DOCKIT_OFFICECLI || '';
    const ADRF = 'docs/adr/ADR-002-officecli-写操作后端.md';
    let sha = '';
    try { sha = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'); } catch {}
    const hasTarget = !!sha && fs.readFileSync(path.join(ROOT, ADRF), 'utf8').includes(sha);
    const flip = sha.slice(-1) === '0' ? '1' : '0';
    return { id: 'M92', file: ADRF, only: 'ADR-002', name: '把 ADR 登记的**在位件** sha 末位改错一号（盘上实算就不再等于任何登记值——「钉版本」是写字不算数的形状；靶按当下实算定位，不写死版本）', find: hasTarget ? sha : sha + '__M92无靶：在位件未登记或后端不在位__', to: hasTarget ? sha.slice(0, 63) + flip : sha, mustRed: ['doc ADR-002 在册'], msg: ['不在 ADR-002 的登记清单'] };
  })(),
  { id: 'M93', file: 'docs/adr/ADR-002-officecli-写操作后端.md', only: 'ADR-002', name: '把排除项 A 那行改成含糊句（`refresh` 仍在文档别处出现 5 次 ⇒ 只有行级锚定才看得见"这一行不再点名被排除的动词"）', find: `**排除项 A：装置永不提供 \`refresh\`。**`, to: `**排除项 A：装置永不提供这一类会拉起 GUI 套件的刷新能力。**`, mustRed: ['ADR-002'], msg: ['排除项 A'] },
  { id: 'M94', file: D, only: 'ADR-002', name: '拆掉后端路径的环境变量覆盖（"可覆盖"从此没人覆盖过；判据自带的那一发 env 探针当场失效）', find: `const resolveOfficecliExe = () => (process.env[OFFICECLI_ENV]`, to: `const resolveOfficecliExe = () => (false && process.env[OFFICECLI_ENV]`, mustRed: ['ADR-002'], msg: ['覆盖'] },
  // ===== R6（v1.6.0）：写能力接入。M47/M48 是《方案》预留的两例，正好补齐编号；M95–M99 各打新加的另几层。
  // 🔴 M47 是本轮的**正面控制**：它把"复制优先"整个打穿（work＝原件本身、跳过 copyfile），
  //    于是后端的写会真落到输入文件——装置的"原件 sha 前后对账"当场抓出并以 code=failed 停手，判据因此红。
  //    这不是"红在选错了跑不到的判据"（v1.1.1 的 M10 教训）：only 里的三条全是正向用例真会执行的路径。
  { id: 'M47', file: D, only: 'edit 承重形状,merge 承重形状,后端二进制与隔离', name: '去掉 copyfile、把原件直接交给后端（承重 1 被打穿的形状——装置的原件 sha 前后对账必须抓住它）', find: `const work = freePath(OUT_DIR, \`\${base}-\${stamp()}-work\`, ext);\n  fs.copyFileSync(input, work);`, to: `const work = input; // M47：不复制，后端直接吃原件`, mustRed: ['edit 承重形状','merge 承重形状','后端二进制与隔离'], msg: ['failed'] },
  { id: 'M48', file: D, only: 'edit 承重形状', name: '拆掉"写后回读对账"这道闸门（后端 success 与"值真落进副本"是两件事：实测 add --prop zzz=… 回退码 2 + success:true 而属性被静默丢弃）', find: "if (entries && perNeedle.length && !allFound) {", to: "if (false && entries && perNeedle.length && !allFound) {", mustRed: ['edit 承重形状'], msg: ['写后回读'] },
  { id: 'M95', file: D, only: 'ADR-002,后端二进制与隔离', name: '🔴 只问 `--version` 的那条懒探针漏传隔离 env（本轮 09:46:59 实犯：后端因此就地自更新 v1.0.153→1.0.154，把钉版打穿）', find: `spawnSync(resolved.exe, ['--version'], { encoding: 'utf8', timeout: 30000, env: officecliEnv() })`, to: `spawnSync(resolved.exe, ['--version'], { encoding: 'utf8', timeout: 30000 })`, mustRed: ['ADR-002'], msg: ['隔离 env'] },
  { id: 'M96', file: D, only: '降级与动词白名单', name: '把动词闸门拆成装饰（refused/code 都不再看白名单——被禁的 install、refresh 就会真的落到子进程）', find: "\n  if (!OFFICECLI_VERB_ALLOW.includes(verb)) {", to: "\n  if (false) {", mustRed: ['降级与动词白名单'], msg: ['闸门'] },
  { id: 'M97', file: D, only: '后端二进制与隔离', name: '把后端原始输出接进回报（`get /` 实测 3,443 B、0 个 CJK 却带 creator/lastModifiedBy 原值——ADR-002 排除项 B）', find: `    backend: { ...r.backend, version: officecliVersion().version, ms: r.ms, spawnDelta: r.spawnDelta },\n    warnings: r.warnings || [],\n    note: \`后端只碰了副本`, to: `    backend: { ...r.backend, rawStdout: r.data, version: officecliVersion().version, ms: r.ms, spawnDelta: r.spawnDelta },\n    warnings: r.warnings || [],\n    note: \`后端只碰了副本`, mustRed: ['后端二进制与隔离'], msg: ['stdout'] },
  { id: 'M98', file: D, only: '降级与动词白名单', name: '把"探测后端"从 copyfile 之前挪走（每次后端缺失都在 _out 留一个垃圾副本——"零副作用降级"被打穿）', find: "  if (!fs.existsSync(resolved.exe)) die('unavailable', `找不到写后端（解析自 ${resolved.source}：${resolved.exe}）`, `装 OfficeCLI 或用 ${OFFICECLI_ENV} 指路；本轮**没有**在 _out 落任何半成品`);", to: "  // M98：探测挪走（下面 officecliCall 照样回 unavailable，但副本已经落进 _out 了）", mustRed: ['降级与动词白名单'], msg: ['落点'] },
  { id: 'M99', file: D, only: 'merge 承重形状', name: '拆掉"空数据不许当成功"那条守卫（后端照收 {} 并回 Replaced keys: 0＝交付一个什么都没填的"成功"）', find: "if (!keys.length) die('invalid-document', '数据 JSON 是空对象——那这次 merge 什么也不会填', '要么给键，要么别调 merge（装置不假装\"成功填了 0 个\"）');", to: "if (false) die('invalid-document', '数据 JSON 是空对象——那这次 merge 什么也不会填', '要么给键，要么别调 merge（装置不假装\"成功填了 0 个\"）');", mustRed: ['merge 承重形状'], msg: ['空对象'] },
  // M100 打 v1.6.1 修的 D-1（监工侧实测抓出，不是执行者自报）：现场半段漏守卫时，缺后端机器上整条判据
  // 会抛 `Cannot read properties of undefined (reading 'sha8')` → selftest 出 FAIL、退码 1，
  // 打穿 ADR-001 立的"没装后端的机器/外人克隆必须依旧全绿"。守卫只在缺后端时触发，本机后端在位，
  // 所以这一例**必须靠 env 注入**才打得红——注入通道由 envPreflight 先验牙，验不过就 ENV-PREFLIGHT 不出结论。
  { id: 'M100', file: D, only: '后端二进制与隔离', name: '🔴 拆掉现场半段的缺后端守卫（退回 D-1：没后端的机器上静态面也一并炸掉，克隆者首跑就红）', find: "    if (!ocliAvailable()) {\n      r6Sweep();", to: "    if (false && !ocliAvailable()) {\n      r6Sweep();", env: { DOCKIT_OFFICECLI: 'D:\\NoSuchDir\\officecli.exe' }, mustRed: ['后端二进制与隔离'], msg: ['最小写用例没成功'] },
  // ---- v1.6.2（ZCode 施工轮）：审查报告 F-1…F-4 的配套变异例。期望值 98→102 是「改的是期望值不是松紧」：
  //      全部是新增攻击面，四条既有判据一条没删没放宽。
  { id: 'M101', file: 'README.md', only: 'v1', name: 'F-2：往 README 正文注入一行行首同形版本串（旧存在性判据对它假绿——命中数=1 的断言必须红）', find: '## 一行调用', to: `版本 v${V} ｜ 正文引述同形行（M101 注入，专打"多命中顶包"）。\n## 一行调用`, mustRed: ['v1'] },
  { id: 'M102', file: D, only: 'check 不起引擎', name: 'F-3：往 cmdCheck 函数体注入 fs.appendFileSync（行为等价写法——字面黑名单防不住，fs 只读白名单必须红）', find: 'const totalConclusions = findings.length;', to: "const totalConclusions = findings.length;\n  try { fs.appendFileSync(TMP_DIR + '/m102-probe.txt', 'x'); } catch (e) {}", mustRed: ['check 不起引擎'], msg: ['fs 方法'] },
  { id: 'M103', file: D, only: '后端二进制与隔离', name: 'F-4：拆掉静态半段的实跑计数器（staticChecks 恒 0——"静态断言实跑条数<5 必红"这条机器断言要接住）', find: 'staticChecks++;', to: '/*M103: 计数被拆*/', mustRed: ['后端二进制与隔离'], msg: ['静态断言实跑条数'] },
  { id: 'M104', file: D, only: 'verify 反向', name: 'F-1：拆掉 verify 反向判据的缺 tesseract 守卫（退回"缺依赖机器上 selftest 红"——F-1 的靶，env 注入才打得红）', find: "    if (!fs.existsSync(TESSERACT_EXE)) return `skip（本机无 tesseract（解析 ${TESSERACT_EXE}）：verify 反向的全部分支都要真跑 OCR，无静态半段可代跑——不冒充通过）`;", to: "    if (false && !fs.existsSync(TESSERACT_EXE)) return `skip（本机无 tesseract（解析 ${TESSERACT_EXE}）：verify 反向的全部分支都要真跑 OCR，无静态半段可代跑——不冒充通过）`;", env: { DOCKIT_TESSERACT: 'Z:\\definitely\\missing\\tesseract.exe' }, mustRed: ['verify 反向'], msg: ['夹具跑不起来'] },
  // ---- v1.6.4（挂账处置轮）：R-A/R-B 的配套变异例。期望值 102→104（**改的是期望值不是松紧**：全部是新增攻击面）。
  { id: 'M105', file: D, only: 'ocr 合成图', name: 'R-B：拆掉 ocr 合成图判据的存在性守卫（退回"装了但坏也 SKIP 掩盖"——存在性口径的牙，env 注入才打得红）', find: "    if (!fs.existsSync(TESSERACT_EXE)) return `skip（本机无 tesseract（解析 ${TESSERACT_EXE}），合成图判据跳过——降级形状由「ocr 降级」覆盖）`;", to: "    if (false && !fs.existsSync(TESSERACT_EXE)) return `skip（本机无 tesseract（解析 ${TESSERACT_EXE}），合成图判据跳过——降级形状由「ocr 降级」覆盖）`;", env: { DOCKIT_TESSERACT: 'Z:\\definitely\\missing\\tesseract.exe' }, mustRed: ['ocr 合成图'], msg: ['识别失败'] },
  { id: 'M106', file: D, only: '依赖覆盖率闸', name: 'R-A 臂④：注入一条吃 runKit 却不带声明的新判据——覆盖率闸必须抓红它（防"新增判据吃依赖忘带声明"复发）', find: "t('v3 版本迭代位规则未被违反：大版本为机主批准的 3（机主 2026-10-14 令「版本号升 3.0.0」；AI 不得自升 X）', () => VERSION.startsWith('3.'));", to: "t('v3 版本迭代位规则未被违反：大版本为机主批准的 3（机主 2026-10-14 令「版本号升 3.0.0」；AI 不得自升 X）', () => VERSION.startsWith('3.'));\n  ta('zc-noise-runaudit 吃 kit 却未登记（M106 注入）', () => { const r = runKit(['capabilities']); return r.ok === true; });", mustRed: ['依赖覆盖率闸'], msg: ['剔除 aud1-stub 控制组'] },
  { id: 'M107', file: D, only: '依赖覆盖率闸', name: 'Q-1：保条数换成员——把注册表里一条真成员换成近似串（条数仍 48，旧「只比条数」口径会静默绿，集合逐字必须抓红）', find: '    "cap 能力矩阵与 kit 实测对账",', to: '    "cap 能力矩阵与 kit 实测对账（M107 换掉的假成员）",', mustRed: ['依赖覆盖率闸'], msg: ['逐名不一致'] },
  // ---- v1.6.6（AUD-1 轮）：A 案归因口径的牙。期望值 105→107（**改的是期望值不是松紧**：全部新增攻击面）。
  { id: 'M108', file: D, only: '依赖覆盖率闸', name: 'AUD-1 (a)：删掉一条判据的 {needs:kit} 声明——缺失态它必须红（不许被洗），覆盖率闸抓 failed≠控制组', find: "t('recalc 无缓存公式被算出（B1=A1*2 → 6）', () => /<v>6<\\/v>/.test(recXlsx()), {needs:'kit'});", to: "t('recalc 无缓存公式被算出（B1=A1*2 → 6）', () => /<v>6<\\/v>/.test(recXlsx()));", mustRed: ['依赖覆盖率闸'], msg: ['剔除 aud1-stub 控制组'] },
  { id: 'M109', file: D, only: 'AUD-1 第四臂哨兵', name: 'AUD-1 (c)：归因置位改恒真（wrapT 退回"任何缺失态红都洗"的事后洗白）——第四臂哨兵必须当场抓洗白复辟', find: "if (needs && needs.needs === 'kit' && !kitPresent())", to: 'if (!kitPresent())', mustRed: ['AUD-1 第四臂哨兵'], msg: ['洗白复辟'] },
  // ---- v1.6.7（WP-A/WP-B 轮）：夹具自产与留档实算的牙。期望值 107→109（**改的是期望值不是松紧**：全部新增攻击面）。
  { id: 'M110', file: D, only: 'zipWrite 逐条目', name: '把自产夹具切到一个不存在的公开夹具路径——回环判据必须发现读取失败', find: "    const odtReal = odtFixturePath;\n    const src = fs.readFileSync(odtReal);", to: "    const odtReal = ROOT + '/test/fixtures/no-such-fixture.odt';\n    const src = fs.readFileSync(odtReal);", mustRed: ['zipWrite 逐条目'], msg: ['threw ENOENT'] },
  { id: 'M111', file: D, only: '后端留档件实算', name: 'WP-B：注入坏归档副本（153 字节被改）并经覆盖口喂给判据——实算 sha 必须与登记逐字不符而红（env 真被吃的运行时证明）', find: "  t('后端留档件实算：bin/archive/officecli-win-x64-<版本>.exe 的 sha256 必须逐字等于登记枚集', () => {", to: "  t('后端留档件实算：bin/archive/officecli-win-x64-<版本>.exe 的 sha256 必须逐字等于登记枚集', () => {\n    process.env.DOCKIT_OFFICECLI_ARCHIVE_DIR = ROOT + '/_tmp/m111-badarchive';\n    fs.mkdirSync(ROOT + '/_tmp/m111-badarchive', { recursive: true });\n    fs.copyFileSync(process.env.DOCKIT_OFFICECLI_ARCHIVE_SEED || 'C:/Windows/Fonts/Alef-Bold.ttf', ROOT + '/_tmp/m111-badarchive/officecli-win-x64-1.0.153.exe');\n    fs.appendFileSync(ROOT + '/_tmp/m111-badarchive/officecli-win-x64-1.0.153.exe', 'M111-TAMPER');", mustRed: ['后端留档件实算'], msg: ['实算'] },
  { id: 'M112', file: D, only: '后端留档件实算', name: 'WP-B：归档目录缺失态必须先 SKIP；拆掉守卫会继续依赖公开仓未登记的归档 SHA 并误报 FAIL', find: "    if (!fs.existsSync(ARCHIVE_DIR)) return 'skip（后端留档目录不在位（解析 ' + ARCHIVE_DIR + '）——外人克隆必走这支；在位机器缺目录属配置缺失，不冒充通过）';", to: "    if (false && !fs.existsSync(ARCHIVE_DIR)) return 'skip（后端留档目录不在位（解析 ' + ARCHIVE_DIR + '）——外人克隆必走这支；在位机器缺目录属配置缺失，不冒充通过）';", env: { DOCKIT_OFFICECLI_ARCHIVE_DIR: path.join(ROOT, '_tmp', 'mutant-no-archive-' + process.pid) }, mustRed: ['后端留档件实算'], msg: ['64 位 hex 认领值'] },
    { id: 'M113', file: D, only: '判据定义数与本轮走到', name: '假判据：在永不执行的分支里定义一条判据——计数说有它、执行里没有，对账网必须当场红（这条正是本轮抓"计数尺子被自身代码污染"时补的网）', find: '  const total = passed + failed + skipped;   // 计数口径含 SKIP', to: "  if (false) {\n    t('M113 定义了但永不执行的探针', () => true);\n  }\n  const total = passed + failed + skipped;   // 计数口径含 SKIP", mustRed: ['判据定义数与本轮走到的条数对账'], msg: ['假判据'] },
  // ---- v1.6.7（监工侧 WP-C 审计轮）：审计的两层防线各配一例，谁能单独打红谁才算数（"冗余防线只有一层挨过攻击"那条教训）。
  { id: 'M114', file: D, only: '后端调用审计', name: 'WP-C：officecliEnv 不再把 TMP/TEMP 指到装置目录（10-06 实犯的那条漏项）——审计若只信自报就发现不了，独立腿必须当场红', find: "const officecliEnv = (tmpDir) => Object.assign({}, process.env, OFFICECLI_ISOLATION_ENV, { TMP: tmpDir || TMP_DIR, TEMP: tmpDir || TMP_DIR });", to: "const officecliEnv = (tmpDir) => Object.assign({}, process.env, OFFICECLI_ISOLATION_ENV);", mustRed: ['后端调用审计'], msg: ['officecliEnv'] },
  { id: 'M115', file: D, only: '后端调用审计', name: 'WP-C：拆掉调用点上的审计写入（函数还在、台账永远不涨）——审计与 spawn 必须一一对应，多写少写都要红', find: '  const auditWrite = auditBackendCall(auditRec);', to: '  const auditWrite = { ok: true };', mustRed: ['后端调用审计'], msg: ['审计'] },
  // ---- v1.6.7 WP-C（监工侧 Q-13）：入口数字对账的两层牙。期望值 113→115（**改的是期望值不是松紧**：全是新增攻击面）。
  { id: 'M116', file: 'README.md', only: '入口数字与源对账', name: 'Q-13：把 README 写的非空入口数改成 +1（登记表没动——数字靠人记就一定会有人对不上）', find: '非空入口数=6', to: '非空入口数=7', mustRed: ['入口数字与源对账'], msg: ['现算 6 条'] },
  { id: 'M117', file: D, only: '入口数字与源对账', name: 'Q-13：把"非空路径条数"数成"总行数"（20 行 vs 6 条非空——尺子选错列时文档数字看着更像对的）', find: "const nonEmpty = rows.filter((r) => r && typeof r['入口文件绝对路径'] === 'string' && r['入口文件绝对路径'].trim()).length;", to: 'const nonEmpty = rows.length;', mustRed: ['入口数字与源对账'], msg: ['现算 20 条'] },
  // ---- v1.7.0（监工侧：引擎依赖恢复 + chi_sim 耐久位 + 语言包哨兵）：期望值 115→117，**改的是期望值不是松紧**——没有一条既有判据被删或被放宽。
  { id: 'M118', file: D, only: 'env doctor', name: '把语言包哨兵的 WARN 升成 FAIL（缺包即整轮红）——「装没装中文包是机器事实，不许打穿外人克隆首跑全绿」这条口径必须当场红', find: "  push('ocr-lang-pack', true, chiSimPresent", to: "  push('ocr-lang-pack', chiSimPresent, chiSimPresent", mustRed: ['env doctor 全绿'], msg: ['整轮判红'] },
  { id: 'M119', file: D, only: 'WP-A 存在性', name: 'v1.6.6 AUD-2 的成果被回退：把「从 gitignore 的 _probe 取 blank.docx、缺件就 SKIP」的旧出口写回审计判据——存在性判据必须点名它（夹具自产不是洁癖：那条自报的 SKIP 不吃 kit，却会被覆盖率闸判成「新吃 kit 没登记」而红，10-07 19:40 清扫后主树首跑就复现）', find: "    const { doc: work } = r6Fixtures(S);", to: "    const srcDoc = path.join(ROOT, '_probe', 'blank.docx');\n    if (!fs.existsSync(srcDoc)) return 'skip（本机没有 _probe/blank.docx，最小写样本造不出来）';\n    const work = path.join(S, 'a-in.docx');\n    fs.copyFileSync(srcDoc, work);", mustRed: ['WP-A 存在性'], msg: ['又出现了'] },
  // ---- v1.7.1 两例：doctor 的裸树守卫、真件夹具入仓。期望值 117→119（**改的是期望值不是松紧**——没有一条既有判据被删或放宽）。
  { id: 'M120', file: D, only: '裸树', name: '把 doctor 引擎扫描那句的 try/catch 拆掉、恢复成裸 readdirSync——node_modules 整棵不在位时必须又退化成"装置内部异常"且 checks 字段消失，裸树判据要当场点名它走了 die 分支（这正是 10-07 19:40 之后调用方实际看到的形状）', find: "  try { eng = fs.readdirSync(ROOT + '/node_modules/@deepseek-ai', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }\n  catch (e) { engWhy = String((e && e.code) || e); }", to: "  eng = fs.readdirSync(ROOT + '/node_modules/@deepseek-ai', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);", mustRed: ['裸树'], msg: ['die 分支'] },
  { id: 'M121', file: D, only: 'WP-A 存在性', name: '把真件 ODT 的路径改回 gitignore 的 _probe（v1.7.1 入仓的成果被回退）——存在性判据必须点名。这条打"入仓"那一半，与 M119 打的"自产"那一半各响各的（规范 §4.4 第 7 条：冗余防线不许搭便车）', find: "    const odtReal = ROOT + '/test/fixtures/cn.odt';", to: "    const odtReal = ROOT + '/_probe/cn.odt';", mustRed: ['WP-A 存在性'], msg: ['又出现了'] },
  // ---- v1.7.2 五例：替身字体哨兵三条覆盖面（M122–M124，各打一层）＋ selftest 两处异步尾巴形状（M125 自建父目录／M126 临时根带进程号）。期望值 119→124（**改的是期望值不是松紧**——没有一条既有判据被删或放宽）。
  { id: 'M122', file: D, only: 'substitute-fonts 哨兵', name: '把"按清单核全量"偷偷退回"只核 7 个固定名"；合成标定机器态必须发现已核数偏离清单', find: '    for (const x of fm.files) {', to: '    for (const x of SENTINELS.map((n) => ({ name: n }))) { // M122：退回只核固定名', mustRed: ['substitute-fonts 哨兵'], msg: ['已核数不等于清单件数'] },
  { id: 'M123', file: D, only: 'substitute-fonts 哨兵', name: '把"清单标定的机器不是本机"那支的 warn 位关掉——清单是机器事实，关掉后这一支渲染成**静默 PASS**（别处克隆会被说成"替身字体全在位"）。🔴 第一版这例是**假攻击**：它改 pass 位，而 push 渲染优先级是 WARN>PASS/FAIL，warn=true 时输出一个字节都没变——台子报"未变红"才暴露，故改打可观测的 warn 位；第二版我又把锚词写成"判红"方向的短语，被"红因缺失"当场抓出（红是对的红因是错的）', find: "'全在位'}`, true);", to: "'全在位'}`, false);", mustRed: ['substitute-fonts 哨兵'], msg: ['非标定机器必须'] },
  // 🔴 CI 首绿轮换靶（2026-10-16）：旧锚串 ` 在位\`), absent.length === 0);` 已被「清单不可读分支恒 WARN
  //    （无校准不判红）」那笔修复改掉（锚点成 0 命中＝ANCHOR-MISS，靠本机 UNAVAILABLE-SKIP 提前短路才没暴露）。
  //    同一味攻击、不删只换靶：清单缺失分支的 warn 位现在硬写 true，改成 false 即"静默渲染成 PASS"。
  { id: 'M124', file: D, only: 'substitute-fonts 哨兵', name: '清单不在位时把 warn 位关掉（→ 静默渲染成 PASS）——覆盖面缺口被"装作体检通过"掩盖，缺清单必须 WARN 并点名解析到的路径。同 M123 的教训：打 pass 位是假攻击，这里打 warn 位', find: " 在位`), true);", to: " 在位`), false);", mustRed: ['substitute-fonts 哨兵'], msg: ['清单缺失必须是'] },
  { id: 'M125', file: D, only: 'WP-A 存在性', name: '删掉惰性 ODT 夹具写入点的自建父目录——套件收尾后才首次访问 mk-odt 时会抛 ENOENT，被顶层兜成 die 信封把整轮 selftest 的 JSON 顶掉（覆盖率闸因此只看到 failed=undefined；2026-10-09 实犯）；静态形状判据必须点名', find: "    fs.mkdirSync(path.dirname(p), { recursive: true });\n", to: '', mustRed: ['WP-A 存在性'], msg: ['自建父目录'] },
  { id: 'M126', file: D, only: 'WP-A 存在性', name: '把 selftest 临时根改回"只到秒"的命名——覆盖率闸 spawn 的缺失态子 selftest 与父进程同秒时会共用同一个 _tmp/selftest-<秒>，先收尾的一方把它删掉，另一方后半程判据成片 ENOENT（2026-10-09 实犯，子轮 failed=17、红因清一色同一个 S 路径）；命名形状判据必须点名', find: "  const S = ensureDir(TMP_DIR + '/selftest-' + stamp() + '-' + process.pid);", to: "  const S = ensureDir(TMP_DIR + '/selftest-' + stamp());", mustRed: ['WP-A 存在性'], msg: ['进程号'] },
  // ---- v1.8.0 五例：非对齐 OLE 副本对齐修复（机主 2026-10-10 批准）。各打一层：触发闸（M127）、对齐算术（M128）、
  //      自报面（M129）、无差别修复反例（M130）、修复路径不许碰输入件（M131）。期望值 124→129（**改的是期望值不是松紧**）。
  { id: 'M127', file: D, only: 'olealign-to,olealign-pages', name: '把非对齐修复的触发闸整个关掉（eligibility 恒假）——修复路径永不进入，to/pages 应退回未修复前的拒法；两条修复判据都必须当场点名', find: "const oleRepairEligible = (r) => r && r.ok === false && r.code === 'invalid-document' && /compound-file header/i.test(String(r.error || ''));", to: "const oleRepairEligible = (r) => false;", mustRed: ['olealign-to', 'olealign-pages'], msg: ['修复后转换未成功', '渲染未成功'] },
  { id: 'M128', file: D, only: 'olealign-to,olealign-pages', name: '把对齐补零算术改错（多补 512 字节）——副本仍然对齐、甚至还能转成功，但 padBytes/字节数自报必须与实算不符；只比对"能转就行"的写法拦不住它', find: "padBytes: 512 - rem };", to: "padBytes: 512 - rem + 512 };", mustRed: ['olealign-to', 'olealign-pages'], msg: ['应为 412'] },
  { id: 'M129', file: D, only: 'olealign-to,olealign-pages', name: '把修复自报整段吞掉（oleRepair 恒返回 undefined）——修复照做、inputRepair/warnings 全没了：调用方无从知道产物来自被修复的副本', find: "function oleRepair(fix, input, warnings) { warnings.push(oleRepairWarn(fix)); return oleRepairField(fix, input); }", to: "function oleRepair(fix, input, warnings) { return undefined; }", mustRed: ['olealign-to', 'olealign-pages'], msg: ['缺 inputRepair'] },
  { id: 'M130', file: D, only: 'olealign-noop', name: '把"已对齐不修"的判定拆掉（rem===0 不再短路）——已对齐件也被拉进修复路径，修复尝试必须被反例判据点名', find: "if (rem === 0) return null;", to: "if (false) return null;", mustRed: ['olealign-noop'], msg: ['无差别修复'] },
  { id: 'M131', file: D, only: 'olealign-to,olealign-pages,olealign-broken', name: '把修复副本的落点改成输入件本身（就地补零）——原件只读被打破，三条判据的零改动检查都必须当场点名', find: "const dst = freePath(OUT_DIR, `${path.basename(input, '.' + inExt)}-${stamp()}-aligned`, inExt);", to: "const dst = input;", mustRed: ['olealign-to', 'olealign-pages', 'olealign-broken'], msg: ['零改动被打破'] },
  // ---- v1.9.0 十三例：media / batch / combine / split 四条新命令（机主 2026-10-10「全面优化升级」）。
  //      期望值 129→142（**改的是期望值不是松紧**，无一条既有判据被删或放宽）。各例 only 的选中子集与 mustRed 严格对号。
  { id: 'M132', file: D, only: 'media 抽取,media ODF', name: '把媒体采集面收窄成只认 word/media（pptx 的 ppt/media 与 ODF 的 Pictures 两族当场失明）', find: "const MEDIA_PREFIXES = ['word/media/', 'ppt/media/', 'xl/media/', 'Pictures/'];", to: "const MEDIA_PREFIXES = ['word/media/'];", mustRed: ['media 抽取', 'media ODF'] },
  { id: 'M133', file: D, only: 'media', name: '把抽出件的 sha256 自报截短（字节数照旧——只有"自报与源条目比对"那一层抓得住）', find: "files.push({ part, file: name, bytes: data.length, sha256: sha256(data), type: mediaKind(data) });", to: "files.push({ part, file: name, bytes: data.length, sha256: sha256(data).slice(0, 24), type: mediaKind(data) });", mustRed: ['media 抽取'] },
  { id: 'M134', file: D, only: 'media 拒绝面', name: '把落点去重拆掉（mediaOutDir 里 freeDir 换成 ensureDir，ZIP/PDF 两支两次跑都写同一个目录——"永不覆盖"在 media 上失效）', find: "  return ensureDir(freeDir(dirFlag ? abs(dirFlag) : OUT_DIR, `${path.basename(input, '.' + extOf(input))}-media-${stamp()}`));", to: "  return ensureDir(dirFlag ? abs(dirFlag) : OUT_DIR);", mustRed: ['media 拒绝面'] },
  { id: 'M135', file: D, only: 'media ODF', name: '把 ODF 的 Thumbnails/ 也拉进采集面（第一页渲染图被当媒体件抽出——版面内容混进媒体面）', find: "const MEDIA_PREFIXES = ['word/media/', 'ppt/media/', 'xl/media/', 'Pictures/'];", to: "const MEDIA_PREFIXES = ['word/media/', 'ppt/media/', 'xl/media/', 'Pictures/', 'Thumbnails/'];", mustRed: ['media ODF'] },
  { id: 'M136', file: D, only: 'media', name: '类型判定恒 unknown（magic 判型整族失明；条数与哈希都对，只有类型断言看得见——OOXML/ODF 与 v2.1.0 的 PDF 抽图三支共用 mediaKind，都该红）', find: 'function mediaKind(b) {', to: "function mediaKind(b) { return 'unknown';", mustRed: ['media 抽取', 'media ODF', 'media 抽 PDF 内嵌图：pdfimages 张数/类型/sha 对账、中文路径落盘、原件零改', 'media PDF 编码自曝'] },
  { id: 'M137', file: D, only: 'media 拒绝面', name: '空包 warning 吞掉（count=0 静默返回——"空结果是数据"少了自报面）', find: 'if (files.length === 0) warnings.push(', to: 'if (false) warnings.push(', mustRed: ['media 拒绝面'] },
  { id: 'M138', file: D, only: 'batch 混合失败', name: '整体判负拆掉（混有坏件也 ok:true——"有失败整体 ok=false"的契约被静默吃掉）', find: "const res = { ok: failed === 0, op: 'batch',", to: "const res = { ok: true, op: 'batch',", mustRed: ['batch 混合失败'] },
  { id: 'M139', file: D, only: 'batch 批量转换,batch 空目录', name: '后缀过滤面拆掉（--ext 不再生效，目录里件件全收——清单数字与"只收匹配件"契约当场不符）', find: 'if (e.isFile() && extList.includes(extOf(e.name))) found.push(p);', to: 'if (e.isFile()) found.push(p);', mustRed: ['batch 批量转换', 'batch 空目录'] },
  { id: 'M140', file: D, only: 'batch 空目录', name: '件数上限拆掉（--max-items 不再拦，超限静默继续——"不静默截断"退化成"不静默全跑"）', find: "if (found.length > maxItems) die('invalid-output',", to: "if (false && found.length > maxItems) die('invalid-output',", mustRed: ['batch 空目录'] },
  { id: 'M141', file: D, only: 'combine 合并', name: '合并顺序整个反过来（页数与哈希都对，只有逐页尺寸的次序断言看得见）', find: 'for (let i = 0; i < docs.length; i++) {', to: 'for (let i = docs.length - 1; i >= 0; i--) {', mustRed: ['combine 合并'] },
  { id: 'M142', file: D, only: 'combine/split 拒绝面', name: '覆盖拒绝拆掉（--out 撞已存在照写——既有文件被改写，"永不覆盖"在 combine 上失效）', find: "if (flags['out'] && fs.existsSync(outPath)) die('invalid-output', `输出已存在：${outPath}`, '装置从不覆盖：换输出路径，或先确认那份要不要留')", to: "if (false && flags['out'] && fs.existsSync(outPath)) die('invalid-output', `输出已存在：${outPath}`, '装置从不覆盖：换输出路径，或先确认那份要不要留')", mustRed: ['combine/split 拒绝面'] },
  { id: 'M143', file: D, only: 'split 范围', name: '区间切片差一（idx 从 0 基错成 1 基——产物页数不变，只有逐页内容断言抓得住）', find: 'const idx = []; for (let i = a; i <= bEnd; i++) idx.push(i - 1);', to: 'const idx = []; for (let i = a; i <= bEnd; i++) idx.push(i);', mustRed: ['split 范围'] },
  { id: 'M144', file: D, only: 'split 拒绝面', name: '互斥闸拆掉（--ranges 与 --every 同给时静默按 ranges 走——"二选一"从拒绝退化成任意选）', find: "if (hasRanges && hasEvery) die('invalid-output',", to: "if (false && hasRanges && hasEvery) die('invalid-output',", mustRed: ['split 拒绝面'] },
  // ---- v1.9.1 五例：加密件拒绝面与消息卫生两层（M145/M146）＋入口指路卡面三层（M147–M149）。期望值 142→147（**改的是期望值不是松紧**）。
  { id: 'M145', file: D, only: 'combine/split 拒绝面', name: '把加密特判关掉（combine 那份 catch 里 enc 恒假）——加密 PDF 的码漂成 invalid-document，拒绝面必须当场点名', find: "const enc = /encrypt/i.test(msg);\n      die(enc ? 'unsupported-format' : 'invalid-document', enc ? `加密 PDF 不在支持面：${p}`", to: "const enc = false; // M145：特判关掉\n      die(enc ? 'unsupported-format' : 'invalid-document', enc ? `加密 PDF 不在支持面：${p}`", mustRed: ['combine/split 拒绝面'], msg: ['加密件 combine 应 unsupported-format'] },
  { id: 'M146', file: D, only: 'combine/split 拒绝面', name: '把库原文提示放回（split 那份 error 重新嵌 msg）——ignoreEncryption 一类绕法提示从出口漏出必须被点名', find: "enc ? `加密 PDF 不在支持面：${input}` : `读不通这份 PDF（${msg.slice(0, 160)}）`, enc ? '先解密再拆", to: "enc ? `读不通这份 PDF：${input}（${msg.slice(0, 160)}）` : `读不通这份 PDF（${msg.slice(0, 160)}）`, enc ? '先解密再拆", mustRed: ['combine/split 拒绝面'], msg: ['ignoreEncryption'] },
  { id: 'M147', file: D, only: '入口指路卡面', name: '把入口卡面检查的"指母本"那层拆成恒真——注入对照从 3 条变 2 条，计数必须当场点名', find: "if (!txt.includes('给其它agent-调用卡.md')) bad.push(", to: "if (false && !txt.includes('给其它agent-调用卡.md')) bad.push(", mustRed: ['入口指路卡面'], msg: ['注入对照没被完整抓住'] },
  { id: 'M148', file: D, only: '入口指路卡面', name: '把"doctor 幂等前置"那层拆成恒真——注入对照计数必须当场点名', find: "if (!txt.includes('dockit.js doctor')) bad.push(", to: "if (false && !txt.includes('dockit.js doctor')) bad.push(", mustRed: ['入口指路卡面'], msg: ['注入对照没被完整抓住'] },
  { id: 'M149', file: D, only: '入口指路卡面', name: '把"命令面现跑 help"那层拆成恒真——注入对照计数必须当场点名', find: "if (!txt.includes('dockit.js help')) bad.push(", to: "if (false && !txt.includes('dockit.js help')) bad.push(", mustRed: ['入口指路卡面'], msg: ['注入对照没被完整抓住'] },
  // ---- v2.1.0 七例：pdftext 文本层（M150 magic／M151 在位降级／M152 区间校验／M156 正文不回显隐私牙）
  //      ＋media 抽 PDF 图（M153 落地前 cap／M154 -list 加密特判）＋inspect AcroForm 探针（M155）。期望值 147→154（改的是期望值不是松紧）。
  { id: 'M150', file: D, only: 'pdftext 拒绝面', name: '拆掉 pdftext 的 %PDF- magic 守卫——非 PDF 漂到 pdftotext，码从 unsupported-format 漂成 invalid-document，拒绝面必须当场点名', find: "buf.slice(0, 5).toString('latin1') !== '%PDF-') die('unsupported-format', 'pdftext", to: "false && buf.slice(0, 5).toString('latin1') !== '%PDF-') die('unsupported-format', 'pdftext", mustRed: ['pdftext 拒绝面：非 PDF/坏区间/页码 0/覆盖（纯参数校验，缺工具也到处能跑）'] },
  { id: 'M151', file: D, only: 'pdftext 降级', name: '拆掉 pdftotext 在位守卫——缺工具不回 unavailable 反而硬起进程漂成 failed，降级牙必须当场点名', find: "if (!tl.present) die('unavailable'", to: "if (false && !tl.present) die('unavailable'", mustRed: ['pdftext 降级：poppler 不在位回 unavailable＋指路 DOCKIT_POPPLER_BIN＋退码 1＋不落半成品'] },
  { id: 'M152', file: D, only: 'pdftext 拒绝面', name: '拆掉 --pages 倒置区间校验——3-1 被放行漂到 pdftotext 报 invalid-document，纯参数拒绝牙必须当场点名', find: "if (m[2] && lastPage < firstPage) die('invalid-output'", to: "if (m[2] && false && lastPage < firstPage) die('invalid-output'", mustRed: ['pdftext 拒绝面：非 PDF/坏区间/页码 0/覆盖（纯参数校验，缺工具也到处能跑）'] },
  { id: 'M153', file: D, only: 'media PDF 拒绝面', name: '拆掉 media PDF 的"数图后、落地前"上限闸——2 图 cap=1 静默全抽并回 dir，批量外放过牙必须当场点名', find: "if (imgCount > cap) die('invalid-output'", to: "if (false && imgCount > cap) die('invalid-output'", mustRed: ['media PDF 拒绝面：非容器/超 cap 落地前拒（不回 dir）/加密件'] },
  { id: 'M154', file: D, only: 'media PDF 拒绝面', name: '拆掉 pdfimages -list 的加密特判（只拆 list 那份，extract 那份保留以证明两层各有牙）——加密件码漂成 invalid-document，加密拒绝牙必须当场点名', find: `if (lr.status !== 0) {
    const err = String(lr.stderr || lr.stdout).trim();
    if (/password|encrypt/i.test(err)) die('unsupported-format'`, to: `if (lr.status !== 0) {
    const err = String(lr.stderr || lr.stdout).trim();
    if (/zzneverlistencrypt/i.test(err)) die('unsupported-format'`, mustRed: ['media PDF 拒绝面：非容器/超 cap 落地前拒（不回 dir）/加密件'] },
  { id: 'M155', file: D, only: 'inspect PDF 表单探针', name: '把 AcroForm 目录键查飞（cat.lookup 拿不到表单目录）——含表单 PDF 被报成 form=null，表单探针牙必须当场点名', find: "cat.lookup(PDFName.of('AcroForm'))", to: "cat.lookup(PDFName.of('zzNoForm'))", mustRed: ['inspect PDF 表单探针：AcroForm 字段计数＋拼拆丢失预警，无表单态为 null'] },
  { id: 'M156', file: D, only: 'pdftext 直取文本层', name: '让 pdftext 把正文回显进 JSON（隐私牙：与 ocr 同口径，文本只落 txt 不进回报）——回显即判据必须当场点名', find: 'pageBreaks, ...(popplerOut !== outPath ? { asciiTmpReroute: true } : {}), ms: Date.now() - t0, warnings:', to: 'pageBreaks, text: txt.slice(0, 50), ...(popplerOut !== outPath ? { asciiTmpReroute: true } : {}), ms: Date.now() - t0, warnings:', mustRed: ['pdftext 直取文本层（数字中文 PDF 免 OCR）：txt 含已知中文、chars>0、正文不回显进 JSON'] },
  // M157–M159 打 v2.2.0 check 的 docx 修订/批注检测（任务书-I 计划2）：ins/del/comments 三条路径各配一次独立攻击。
  { id: 'M157', file: D, only: '修订/批注', name: '把 w:ins 从修订正则里摘掉（只留 del）——插入修订漏检、revisions 2→1，修订牙必须当场点名', find: "for (const m of str(d).matchAll(/<w:(ins|del)\\b([^>]*?)>/g)) {", to: "for (const m of str(d).matchAll(/<w:(del)\\b([^>]*?)>/g)) {", mustRed: ['check docx 修订/批注：含 w:ins/w:del 与 comments.xml 时分别点名'] },
  { id: 'M158', file: D, only: '修订/批注', name: '把 w:del 从修订正则里摘掉（只留 ins）——删除修订漏检、revisions 2→1，修订牙必须当场点名', find: "for (const m of str(d).matchAll(/<w:(ins|del)\\b([^>]*?)>/g)) {", to: "for (const m of str(d).matchAll(/<w:(ins)\\b([^>]*?)>/g)) {", mustRed: ['check docx 修订/批注：含 w:ins/w:del 与 comments.xml 时分别点名'] },
  { id: 'M159', file: D, only: '修订/批注', name: '把批注正则打飞（w:comment→w:zzcomment）——批注漏检、comments 1→0，批注牙必须当场点名', find: "for (const m of str(cpart).matchAll(/<w:comment\\b([^>]*?)>/g)) {", to: "for (const m of str(cpart).matchAll(/<w:zzcomment\\b([^>]*?)>/g)) {", mustRed: ['check docx 修订/批注：含 w:ins/w:del 与 comments.xml 时分别点名'] },
  // M160–M161 打 v2.2.0 pages 的 poppler 降级（任务书-I 计划4）：PDF-only 守卫与 poppler 缺失返回 null 各一层。
  { id: 'M160', file: D, only: 'pages 降级', name: '拆掉降级的 PDF-only 守卫（OOXML 也被塞给 pdftoppm）——OOXML 应回 unavailable 却变成 invalid-document', find: `if (b0.slice(0, 5).toString('latin1') === '%PDF-') {`, to: `if (true) {`, mustRed: ['pages 降级'] },
  { id: 'M161', file: D, only: 'pages 降级', name: '拆掉 poppler 缺失时的 return null（poppler 也缺失时硬跑）——应回 unavailable 却变成 invalid-document', find: `const pt = popplerTool('pdftoppm');
  if (!pt.present) return null;
  ensureDir(dir);`, to: `const pt = popplerTool('pdftoppm');
  if (!pt.present) { }
  ensureDir(dir);`, mustRed: ['pages 降级'] },
  // M162–M163 打 v2.2.0 recalc 的逐格错误地图（任务书-I 计划5）：错误检测与公式计数各一层。
  { id: 'M162', file: D, only: 'report-errors', name: '把错误格检测整体打飞（isErr 恒 false）——错误地图漏报 3 个错误、totalErrorCells 3→0', find: `const isErr = /\\st="e"/.test(attrs) || (typeof v === 'string' && /^#[A-Z0-9/?!]+!?$/.test(v.trim()));`, to: `const isErr = false;`, mustRed: ['report-errors'] },
  { id: 'M163', file: D, only: 'report-errors', name: '把公式计数打飞（totalFormulas 3→0）——错误地图的分母漏报', find: `if (/<f(?:\\s[^>]*)?>/.test(inner)) totalFormulas++;`, to: `if (false) totalFormulas++;`, mustRed: ['report-errors'] },
  // M164 打 v2.2.0 media 的 --reencode 非法值校验（任务书-I 计划6）：拆掉校验后 gif 被静默接受。
  { id: 'M164', file: D, only: 'pdftext/media 开关', name: '把 --reencode 非法值校验打飞（gif 被静默接受、不回 invalid-output）', find: `if (reencode !== null && reencode !== 'jpeg') die('invalid-output',`, to: `if (false) die('invalid-output',`, mustRed: ['pdftext/media 开关'] },
  // M165–M167 打 v2.2.0 pageops（任务书-I 计划10）：旋转/删页/重排三个动作各一颗牙。
  { id: 'M165', file: D, only: 'pageops 页级操作', name: 'rotate 把角度写死成 0（setRotation 不生效）', find: `all[i].setRotation({ type: 'degrees', angle: deg });`, to: `all[i].setRotation({ type: 'degrees', angle: 0 });`, mustRed: ['pageops 页级操作'] },
  { id: 'M166', file: D, only: 'pageops 页级操作', name: 'delete 的过滤被打飞（应删的页没删）', find: `seq = src.getPageIndices().filter((i) => !del.has(i));`, to: `seq = src.getPageIndices().filter((i) => true);`, mustRed: ['pageops 页级操作'] },
  { id: 'M167', file: D, only: 'pageops 页级操作', name: 'order 不按给定顺序（被悄悄排回原序）', find: `seq = given;`, to: `seq = given.slice().sort((a, b) => a - b);`, mustRed: ['pageops 页级操作'] },
  // M168–M169 打 v2.2.0 pipeline（任务书-I 计划11）：跳过 to 的检测与 ocr 步触发。
  { id: 'M168', file: D, only: 'pipeline 串联', name: 'PDF 输入的跳过 to 检测被打飞（PDF 也强跑 to）', find: "function inputIsPdf(input) {\n  const fd = fs.openSync", to: "function inputIsPdf(input) {\n  return false; // M168：判位恒假（后面的读取变成不可达）\n  const fd = fs.openSync", mustRed: ['pipeline 串联'] },
  // M169（v2.2.0 立，v2.4.0 换靶）：pipeline 的 ocr 步不触发（被静默吞掉）——同味攻击，锚点随步序列重构从"flow 分支"换到"stepName 分支"。
  { id: 'M169', file: D, only: 'pipeline 串联', name: 'to-pages-ocr 的 ocr 步不触发（被静默吞掉）', find: `} else if (stepName === 'ocr') {`, to: `} else if (false && stepName === 'ocr') {`, mustRed: ['pipeline 串联'], needsCap: 'tesseract' },
  // M170–M171 给 media 超限 / split 封顶两条子层补独立变异（任务书-I 计划9①）。
  { id: 'M170', file: D, only: 'media PDF 拒绝面', name: 'media(PDF) 超 cap 落地前拒被打飞（超量也照抽）', find: `if (imgCount > cap) die('invalid-output',`, to: `if (false) die('invalid-output',`, mustRed: ['media PDF 拒绝面'] },
  { id: 'M171', file: D, only: 'split 拒绝面', name: 'split 封顶拒绝被打飞（超 100 件也照拆）', find: `if (ranges.length > SPLIT_MAX_OUTPUTS) die('invalid-output',`, to: `if (false) die('invalid-output',`, mustRed: ['split 拒绝面'] },
  // M172（v2.2.1）：pipeline 中途失败即停——拆掉 process.exit，从"单行 JSON＋退码 1"变成双输出且伪报"装置内部异常"。
  { id: 'M172', file: D, only: 'pipeline 串联', name: '把 pipeline 中途失败的即停拆掉（去掉 process.exit——变双输出且伪报装置内部异常）', find: `next: j ? j.next : '把本行 JSON 原样回报；上游步骤产物在 steps[]' });
      process.exit(1);   // 失败即停：只出一行、退码 1`, to: `next: j ? j.next : '把本行 JSON 原样回报；上游步骤产物在 steps[]' });`, mustRed: ['pipeline 串联'] },
  // M173–M174（v2.3.0）：spawn 统一包装的防回退哨兵两层。M173 打主文件（把钉桩值掏空 ⇒ 判据的"钉桩字面"层），
  // M174 打覆盖面（同一哨兵必须核到 test 侧宿主文件，只保主文件＝覆盖面缺口）。改了代码却让字面只在注释里活着，
  // 这两例会把假绿当场揭穿（注释一律描述式、不抄字面——纪律与理由见判据注释）。
  { id: 'M173', file: D, only: 'spawn 统一 stdio', name: '把 dockit.js 的 stdin 钉桩掏出（SPAWN_STDIO_DEFAULT 置 undefined——等于退回本会话宿主上的 spawn 全灭形状）', find: `const SPAWN_STDIO_DEFAULT = ['ignore', 'pipe', 'pipe'];`, to: `const SPAWN_STDIO_DEFAULT = undefined;`, mustRed: ['spawn 统一 stdio'] },
  { id: 'M174', file: 'test/char-baseline.js', only: 'spawn 统一 stdio', name: '把 char-baseline.js 的 stdin 钉桩掏出（专打覆盖面层：哨兵必须核到 test 侧宿主文件，不只核主文件）', find: `const SPAWN_STDIO_DEFAULT = ['ignore', 'pipe', 'pipe'];`, to: `const SPAWN_STDIO_DEFAULT = undefined;`, mustRed: ['spawn 统一 stdio'] },
  // M175–M177（v2.3.0）：markdown 命令三层各一颗牙——缺件降级（ADR 级形状）、正文隐私、输出撞车（永不覆盖）。
  { id: 'M175', file: D, only: 'markdown 降级', name: '拆掉 markdown 的 pandoc 在位守卫（缺工具时应 unavailable＋指路，却一路撞到 spawn 报 failed）', find: "function requirePandoc() {\n  const pd = pandocTool();\n  if (!pd.present) die(", to: "function requirePandoc() {\n  const pd = pandocTool();\n  if (false && !pd.present) die(", mustRed: ['markdown 降级'] },
  { id: 'M176', file: D, only: 'markdown 正向', name: '把 markdown 产物正文回显进回报 JSON（raw: md——隐私口径与 ocr/pdftext 同族的反面）', find: `out({ ok: true, op: 'markdown', backend: 'pandoc', tool: pd.exe, toolSource: pd.source,`, to: `out({ ok: true, op: 'markdown', raw: md, backend: 'pandoc', tool: pd.exe, toolSource: pd.source,`, mustRed: ['markdown 正向'] },
  { id: 'M177', file: D, only: 'markdown 拒绝面', name: '拆掉 markdown 的输出撞车拒绝（允许覆盖已有 .md——"永不覆盖"被打破）', find: `if (positional[1]) { outPath = abs(positional[1]); if (fs.existsSync(outPath)) die(`, to: `if (positional[1]) { outPath = abs(positional[1]); if (false && fs.existsSync(outPath)) die(`, mustRed: ['markdown 拒绝面'] },
  // M178（v2.4.0）：pipeline 步序列的牙——未知步拒绝层。🔴 watermark 两例（字体守卫/表单拒绝）曾随 v2.4.0 首版
  // 实现配过 M178/M179，机主当轮裁撤 watermark 后两例随能力一起撤（锚点已不在源码），编号收回重用给本例。
  { id: 'M178', file: D, only: 'pipeline 步序列', name: '拆掉 pipeline 步序列的未知步拒绝（nonsense 步被静默跳过）', find: `for (const s of flowSteps) if (!PIPE_STEPS.includes(s)) die(`, to: `for (const s of flowSteps) if (false && !PIPE_STEPS.includes(s)) die(`, mustRed: ['pipeline 步序列'] },
  // M179（v2.4.1）：parsePageList 的空页清单拒绝层（watermark 的旧编号收回重用）。实测 pageops rotate --pages '' 曾静默无操作却报 ok（假成功）。
  { id: 'M179', file: D, only: 'pageops 页级操作', name: '拆掉空页清单拒绝（--pages "" 静默无操作却报 ok——假成功复辟）', find: `if (!res.length) die('invalid-output', \`页清单为空`, to: `if (false && !res.length) die('invalid-output', \`页清单为空`, mustRed: ['pageops 页级操作'] },

  // M180–M189（v2.5.0）：skill 对照轮第三棒——scrub 的 PDF 面四层（XMP 块／Info 循环／撞车／字节尺）、
  // pdfform 三层（XFA 守卫／选项白名单／文本写入回读对账）、markdown 修订足迹三层（透传／值校验／docx-only 守卫）。
  // 期望值 177→187（**改的是期望值不是松紧**——没有一条既有判据被删或放宽）。各例 only 与 mustRed 严格对号。
  { id: 'M180', file: D, only: 'pdfform 拒绝面', name: '拆掉 pdfform 的 XFA 守卫（pdf-lib 一碰 getForm() 就把 XFA 静默剥掉——守卫必须在它之前；没了守卫，XFA 件会被先剥壳再当普通表单）', find: "if (af instanceof PDFDict && af.get(PDFName.of('XFA'))) die('unsupported-format'", to: "if (false && af instanceof PDFDict && af.get(PDFName.of('XFA'))) die('unsupported-format'", mustRed: ['pdfform 拒绝面'], msg: ['XFA 件应'] },
  { id: 'M181', file: D, only: 'pdfform 拒绝面', name: '拆掉 pdfform 的选项白名单（选项外值被静默放行或由库抛失败——必须从 invalid-output 漂走）', find: "if (!opts.includes(sv)) die('invalid-output'", to: "if (false && !opts.includes(sv)) die('invalid-output'", mustRed: ['pdfform 拒绝面'], msg: ['选项外值应'] },
  { id: 'M182', file: D, only: 'pdfform 正向', name: '把 pdfform 的文本写入掏空（setText 不生效——装置自己的写后回读对账必须报回读不符，独立回读再抓一层）', find: "if (p.t === 'text') { p.f.setText(p.v); if (cjkFont && /[^\\x00-\\xFF]/.test(p.v)) p.f.updateAppearances(cjkFont); }", to: "if (p.t === 'text') { /* M182：写入掏空 */ }", mustRed: ['pdfform 正向'], msg: ['回读对账不符'], needsCap: 'cjkFormFont' },
  { id: 'M183', file: D, only: 'scrub PDF 面', name: '拆掉 scrub(PDF) 的 XMP 双删块（catalog 引用＋context 对象都不删——XMP 原文整段留在产物里）', find: "const hadXmp = !!metaRef;\n  if (hadXmp) {", to: "const hadXmp = !!metaRef;\n  if (false && hadXmp) {", mustRed: ['scrub PDF 面'], msg: ['removedFields 缺 XMP:/Metadata'] },
  { id: 'M184', file: D, only: 'scrub PDF 面', name: '把 scrub(PDF) 的 /Info 目标键删除循环掏空（Info 六键全留）', find: "for (const k of PDF_META_TARGETS) { const key = PDFName.of(k);", to: "for (const k of []) { const key = PDFName.of(k);", mustRed: ['scrub PDF 面'], msg: ['removedFields 缺 Info:Title'] },
  { id: 'M185', file: D, only: 'scrub PDF 面', name: '拆掉 scrub(PDF) 的输出撞车拒绝（已存在照写——“永不覆盖”在 PDF 面失效）', find: "const output = positional[1] ? abs(positional[1]) : freePath(OUT_DIR, `${path.basename(input, '.' + extOf(input))}-scrubbed`, 'pdf');\n  if (positional[1] && fs.existsSync(output)) die('invalid-output',", to: "const output = positional[1] ? abs(positional[1]) : freePath(OUT_DIR, `${path.basename(input, '.' + extOf(input))}-scrubbed`, 'pdf');\n  if (false && positional[1] && fs.existsSync(output)) die('invalid-output',", mustRed: ['scrub PDF 面'], msg: ['撞车'] },
  { id: 'M186', file: D, only: 'markdown 修订足迹', name: '拆掉 markdown 的 --track-changes 透传（视图换不了：reject/all 都退回默认 accept 视图）', find: "if (trackChanges !== null) pargs.push('--track-changes=' + trackChanges);", to: "if (false && trackChanges !== null) pargs.push('--track-changes=' + trackChanges);", mustRed: ['markdown 修订足迹'], msg: ['reject 视图应'] },
  { id: 'M187', file: D, only: 'markdown 修订足迹', name: '拆掉 --track-changes 的值校验（bogus 值漂给 pandoc，码从 invalid-output 漂成 invalid-document）', find: "if (trackChanges !== null && !['accept', 'reject', 'all'].includes(trackChanges)) die('invalid-output'", to: "if (false && trackChanges !== null && !['accept', 'reject', 'all'].includes(trackChanges)) die('invalid-output'", mustRed: ['markdown 修订足迹'], msg: ['非法值应'] },
  { id: 'M188', file: D, only: 'markdown 修订足迹', name: '拆掉 --track-changes 的 docx-only 守卫（odt 也被放行——非 Word 族本就没有修订面）', find: "if (trackChanges !== null && inExt !== 'docx') die('invalid-output'", to: "if (false && trackChanges !== null && inExt !== 'docx') die('invalid-output'", mustRed: ['markdown 修订足迹'], msg: ['非 docx 用'] },
  { id: 'M189', file: D, only: 'scrub PDF 面', name: '把 scrub(PDF) 的字节尺打回原形（Buffer.from 拆掉——save 返回的 Uint8Array 走 TypedArray.join，tokenScan 恒空；孤儿残留的正面用例必须点名）', find: "const lat = Buffer.from(bytesOut).toString('latin1');", to: "const lat = bytesOut.toString('latin1');", mustRed: ['scrub PDF 面'], msg: ['字节尺应点出孤儿'] },
  // ---- v2.6.0：check 的外发风险面（OOXML/ODF 五族＋PDF 六族＋覆盖面自述）＋factcheck --refs＋batch --cmd
  { id: 'M190', file: D, only: '外发风险五族', name: 'docx 隐藏文本的正则族名打错（整个 hidden-content 族哑火）', find: "<w:(vanish|webHidden)", to: "<w:(zzzVanish|webHidden)", mustRed: ['外发风险五族'], msg: ['hidden-content 应为 2'] },
  { id: 'M191', file: D, only: '外发风险五族', name: '拆掉 w:val="0" 的豁免（显式把隐藏关掉的标记也被点名＝过度报告，会把人训成忽略结论）', find: "if (/\\sw:val=\"(0|false|off|never)\"/.test(m[0])) continue;", to: "if (false) continue;", mustRed: ['外发风险五族'], msg: ['hidden-content 应为 2'] },
  { id: 'M192', file: D, only: '外发风险五族', name: '外部引用的关系扫描正则失效（TargetMode="External" 一族静默放行）', find: "/<Relationship\\b[^>]*?\\sTargetMode=\"External\"", to: "/<Relationship\\b[^>]*?\\sTargetMode=\"ExternalZZ\"", mustRed: ['外发风险五族'], msg: ['external-link 应为 1'] },
  { id: 'M193', file: D, only: '外发风险五族', name: '把外部链接的**目标**写进 locator（隐私口径破了：地址里可能带用户名与内网主机名）', find: "add('external-link', name, `Relationship Id=${(/\\bId=\"([^\"]*)\"/.exec(m[0])", to: "add('external-link', name, `Target=${(/Target=\"([^\"]*)\"/.exec(m[0])", mustRed: ['外发风险五族'], msg: ['回报里出现了夹具秘密串'] },
  { id: 'M194', file: D, only: '外发风险五族', name: 'VBA 工程的部件匹配打错（宏这一族整族漏报——可执行载体是最该点名的一条）', find: "if (!/^(?:word|ppt|xl)\\/vbaProject\\.bin$/.test(name)) continue;", to: "if (!/^zzz$/.test(name)) continue;", mustRed: ['外发风险五族'], msg: ['macro 应为 2'] },
  { id: 'M195', file: D, only: '外发风险五族', name: '拆掉自定义属性的空值豁免（空属性也被点名＝过度报告）', find: "if (!v.trim()) continue;", to: "if (false) continue;", mustRed: ['外发风险五族'], msg: ['custom-xml 应为 2'] },
  { id: 'M196', file: D, only: '外发风险五族', name: 'ODF 隐藏单元格的元素清单打错（ODF 侧 hidden-content 哑火，OOXML 侧照绿＝覆盖面塌一半）', find: "<(table:table-cell|table:table-row|table:table-column)\\b[^>]*?\\stable:visibility=\"hidden\"", to: "<(table:ZZZ)\\b[^>]*?\\stable:visibility=\"hidden\"", mustRed: ['外发风险五族'], msg: ['ODF 的 hidden-content 应为 2'] },
  { id: 'M197', file: D, only: 'check PDF 面', name: '拆掉 PDF 的 /Info 目标键循环（元数据那一面哑火——与 scrub 的 PDF 面互为对照，这边漏了对面就看不见）', find: "add('meta-field', 'trailer:/Info', k,", to: "if (false) add('meta-field', 'trailer:/Info', k,", mustRed: ['check PDF 面'], msg: ['meta-field 应为 7'] },
  { id: 'M198', file: D, only: 'check PDF 面', name: '🔴 拆掉整层"结构自证"（Root 取不到与页树读不通两道闸一起摘——pdf-lib 对坏件 load 不抛、返回空壳，没了这两层坏件就被洗成 ok＋clean=true，假成功比报错坏得多）', find: "  if (!(rootCat instanceof PDFDict)) return { loadError: { code: 'invalid-document', error: 'load 没抛错但取不到 /Root 目录对象（交叉表或目录缺失）：这一面判不了，别把坏件当\"查过且干净\"' } };\n  let pageCount = null;\n  try { pageCount = doc.getPageCount(); } catch (e) { return { loadError: { code: 'invalid-document', error: '页树读不通：' + String((e && e.message) || e).slice(0, 140) } }; }", to: "  if (false && !(rootCat instanceof PDFDict)) return { loadError: { code: 'invalid-document', error: 'M198' } };\n  let pageCount = null;\n  try { } catch (e) { return { loadError: { code: 'invalid-document', error: 'M198' } }; }", mustRed: ['check PDF 面'], msg: ['坏 PDF 竟然报通过'] },
  { id: 'M199', file: D, only: 'check PDF 面', name: '逐对象扫描只认 PDFDict（v2.6.0 首版实犯：附件与 XMP 都是**流**，/Type /EmbeddedFile 整族漏掉）', find: "if (!isDict && !isStream) continue;", to: "if (!isDict) continue;", mustRed: ['check PDF 面'], msg: ['embedded-object 应为 1'] },
  { id: 'M200', file: D, only: 'check PDF 面', name: 'XMP 流不做 inflate（FlateDecode 的包读不进去，字段全看不见）', find: "text = filter === 'FlateDecode' ? zlib.inflateSync(raw).toString('latin1') : raw.toString('latin1');", to: "text = raw.toString('latin1');", mustRed: ['check PDF 面'], msg: ['meta-field 应为 7'] },
  { id: 'M201', file: D, only: '覆盖面自述', name: 'counts 改成从**截断后的清单**算（截断动了权威值：报告里的数不再等于件里真有几处）', find: "for (const f of findings) counts[f.kind] = (counts[f.kind] || 0) + 1;", to: "for (const f of findings.slice(0, CHECK_FINDINGS_CAP)) counts[f.kind] = (counts[f.kind] || 0) + 1;", mustRed: ['覆盖面自述'], msg: ['counts 应权威'] },
  { id: 'M202', file: D, only: '覆盖面自述', name: '把 revisions 从 docx 的适用面里摘掉（命令面宣告的族没有任何容器会查＝假族名）', find: "docx: ['meta-field', 'missing-alt-text', 'revisions',", to: "docx: ['meta-field', 'missing-alt-text',", mustRed: ['覆盖面自述'], msg: ['假族名'] },
  { id: 'M203', file: D, only: 'refs', name: '拆掉行号引用的上界判定（越界的引用被当界内放过——这条判据的全部牙就在这层）', find: "const over = want1 > nl2 || (want2 !== null && want2 > nl2);", to: "const over = false;", mustRed: ['refs'], msg: ['行号越界'] },
  { id: 'M204', file: D, only: 'refs', name: '把 --refs 变成默认开（历史文档会被成片点名，调用方学到的第一课就是忽略结论）', find: "if (refsOn) {", to: "if (true) {", mustRed: ['refs'], msg: ['不开 --refs 却查了行号引用'] },
  { id: 'M205', file: D, only: 'batch --cmd', name: 'batch 的 markdown 支被吃掉（--cmd 变成摆设，逐件仍走 to）', find: "if (cmdName === 'markdown') {", to: "if (false && cmdName === 'markdown') {", mustRed: ['batch --cmd'], msg: ['两件 docx 应都成'] },
  { id: 'M206', file: D, only: 'batch --cmd', name: '拆掉 --cmd markdown 与 --to 的互斥守卫（两支命令面的参数混着给还放行）', find: "if (cmdName === 'markdown' && flags.to !== undefined) die('invalid-output'", to: "if (false && cmdName === 'markdown' && flags.to !== undefined) die('invalid-output'", mustRed: ['batch --cmd'], msg: ['两支命令面混在一起'] },
  { id: 'M207', file: D, only: "redline", name: "delete 的 w:t→w:delText 转换被打回原形（包了 w:del 但里面还是 w:t＝Word 视为坏件，\"被删的字\"根本没标成删除）", find: "r[0].replace(/<w:t(\\b[^>]*)>/g, '<w:delText$1>'", to: "r[0].replace(/<w:t(\\b[^>]*)>/g, '<w:t$1>'", mustRed: ["redline 修订写入"], msg: ["被删的文字没进 w:delText"] },
  { id: 'M208', file: D, only: "redline", name: "insert 的 w:ins 包裹拆掉（新文字以裸 run 混进正文＝修订痕迹消失，交付方看不见这是插入的）", find: "const insBlock = `<w:ins w:id=", to: "const insBlock = `<w:zzzIns w:id=", mustRed: ["redline 修订写入"], msg: ["没写进 w:ins"] },
  { id: 'M209', file: D, only: "redline", name: "accept 的\"丢弃删除内容\"支拆掉（接受修订后被删的字还留在正文里）", find: "xml = xml.replace(/<w:del\\b", to: "xml = xml.replace(/<w:zzzdel\\b", mustRed: ["redline 修订写入"], msg: ["接受后被删的文字应当消失"] },
  { id: 'M210', file: D, only: 'redline', name: 'reject 的 delText→w:t 还原拆掉（拒绝修订后文字回不来，正文缺一段却自称处理过）', find: ".replace(/<w:delText(\\b[^>]*)>/g, '<w:t$1>')", to: ".replace(/<w:zzzDelText(\\b[^>]*)>/g, '<w:t$1>')", mustRed: ['redline 修订写入'], msg: ['应当还原成正常文本'] },
  { id: 'M211', file: D, only: "redline", name: "批注的 rels 登记拆掉（包里有 comments.xml 却没有指向它的关系：只看部件的读者觉得没问题，Word 直接报损坏）", find: "      if (!/comments/.test(r)) {", to: "      if (false && !/comments/.test(r)) {", mustRed: ["redline 修订写入"], msg: ["没有 rels 指向它"] },
  { id: 'M212', file: D, only: "redline", name: "格式修订的 reject 守卫拆掉（把\"旧属性表还原\"这件做不了的事假装做了）", find: "if (fmt.length) die('unsupported-format'", to: "if (false && fmt.length) die('unsupported-format'", mustRed: ["redline 修订写入"], msg: ["格式修订"] },
  { id: 'M213', file: D, only: "redact", name: "🔴 删算子那一步拆掉、只画黑框（视觉盖住但文本层还在＝假涂黑，正是本命令存在的理由被抽空）", find: "          if (!inside) continue;", to: "          if (true) continue;", mustRed: ["redact 真涂黑"], msg: ["正向跑不通"] },
  { id: 'M214', file: D, only: "redact", name: "needle 找不到的前置拒拆掉（找不到就等于给了调用方一张空白的脱敏回执）", find: "if (notFound.length && !dryRun) die('invalid-output'", to: "if (false && notFound.length && !dryRun) die('invalid-output'", mustRed: ["redact 真涂黑"], msg: ["needle 找不到却没拒"] },
  { id: 'M215', file: D, only: "tables", name: "词框纵坐标换算写反（pdftotext 顶原点、内容流底原点；不换算就把词塞进错行——表头跑到表尾）", find: "cy: ph - (w.yMin + w.yMax) / 2", to: "cy: (w.yMin + w.yMax) / 2", mustRed: ["tables 几何抽取"], msg: ["表头行顺序不对"] },
  { id: 'M216', file: D, only: "compress", name: "可达性回收退化成\"删掉全部间接对象\"（闭包写反：页数与正文必然对不上，无损核验必须抓）", find: "for (const [ref] of [...doc.context.enumerateIndirectObjects()]) if (!reachable.has(ref.objectNumber))", to: "for (const [ref] of [...doc.context.enumerateIndirectObjects()]) if (true)", mustRed: ["compress"] },
  { id: 'M217', file: D, only: "compress", name: "可达性回收整段拆掉（孤儿对象原样留在产物里——声称瘦身却没瘦）", find: "for (const [ref] of [...doc.context.enumerateIndirectObjects()]) if (!reachable.has(ref.objectNumber))", to: "for (const [ref] of [...doc.context.enumerateIndirectObjects()]) if (false && !reachable.has(ref.objectNumber))", mustRed: ["compress"], msg: ["没被回收"] },
  { id: 'M218', file: D, only: "DAG", name: "when 谓词恒真（条件分支形同虚设：该跳过的节点照样跑，DAG 与线性序列没了区别）", find: "  const whenOk = (w, resOf) => {", to: "  const whenOk = (w, resOf) => { if (w) return true;", mustRed: ["pipeline DAG"], msg: ["when 不成立"] },
  { id: 'M219', file: D, only: "DAG", name: "成环检测拆掉（拓扑排不完时静默只跑排出的那部分，下游被无声丢掉）", find: "if (order.length !== nodes.length) die('invalid-output'", to: "if (false && order.length !== nodes.length) die('invalid-output'", mustRed: ["pipeline DAG"], msg: ["成环没被拒"] },
  { id: 'M220', file: D, only: "DAG", name: "多 to 节点守卫拆掉（一图两个源文件＝语义未定义，产物归属说不清）", find: "if (nodes.filter((n) => n.step === 'to').length > 1) die('invalid-output'", to: "if (false && nodes.filter((n) => n.step === 'to').length > 1) die('invalid-output'", mustRed: ["pipeline DAG"], msg: ["多个 to 节点没拒"] },
  { id: 'M221', file: D, only: "编码自曝", name: "🔴 JBIG2/JPEG2000 的\"这是原始流不是位图\"警告拆掉（调用方会拿 .jb2e/.jp2 当可显示的图继续往下走）", find: "  if (rawStream.length) warnings.push(", to: "  if (false && rawStream.length) warnings.push(", mustRed: ["media PDF 编码自曝"], msg: ["没自曝"] },
  { id: 'M222', file: D, only: "编码自曝", name: "-list 的 enc 列解析打飞（编码信息全变 unknown：压测面等于没测）", find: "enc: m[9]", to: "enc: 'unknown'", mustRed: ["media PDF 编码自曝"], msg: ["没按编码自曝"] },
  { id: 'M223', file: D, only: "frommd", name: "pandoc 的 --output 参数拆掉（后端把内容吐到 stdout、\"报成功却没落产物\"的谎报落点形状复辟）", find: "spawnSync(pd.exe, [input, '--output', outPath, ...base", to: "spawnSync(pd.exe, [input, ...base", mustRed: ["frommd 生产方向"] },
  { id: 'M224', file: 'test/mutant.js', only: '变异台写盘韧性', name: '把 writeHard 的重试上界从 8 压到 1（＝瞬时文件锁直接等于整轮报废）——韧性层判据必须红（🔴 自指例：锚串在源码里用拼接断开，否则 split 会数到定义行那一处）', find: "  for (let i = 0; i < 8; i" + "++) {", to: "  for (let i = 0; i < 1; i" + "++) {", mustRed: ['变异台写盘韧性'], msg: ['重试上界'] },
  { id: 'M225', file: 'test/mutant.js', only: '变异台写盘韧性', name: '把结论打印挪回收尾还原之后（旧顺序：还原抛穿 finally 就吞掉整轮读数）——顺序判据必须红（自指例，锚串拼接断开）', find: "  console.log(JSON.stringify(rows, null, 1));\n  for (const [p, buf] of touch" + "ed) writeHard(p, buf, '收尾还原');", to: "  for (const [p, buf] of touched) writeHard(p, buf, '收尾还原');\n  conso" + "le.log(JSON.stringify(rows, null, 1));", mustRed: ['变异台写盘韧性'], msg: ['还原'] },
  { id: 'M226', file: D, only: 'sheetop', name: '别的表里指向被编辑表的引用不再映射（把"限名"那一支的条件打飞，让它走"不是被编辑的表"的早退）——跨表引用判据必须红', find: '  if (refObj.sheet !== null) {', to: '  if (false && refObj.sheet !== null) {', mustRed: ['sheetop 引用重写'], msg: ['别表指向本表'] },
  { id: 'M227', file: D, only: 'sheetop', name: '绝对引用 $A$3 当"钉住不动"不平移（Excel 插行/移列要连绝对引用一起移）——🔴 这条打在**映射函数本体**上，写它与验它同源 ⇒ 结构对账必然自洽，只有判据里那份**字面期望**抓得住（这正是判据不拿装置自己的映射回算的理由）', find: "  const mk = (p) => `${p.absCol ? '$' : ''}${idxToCol(mapCol(colToIdx(p.col)))}${p.absRow ? '$' : ''}${mapRow(p.row)}`;", to: "  const mk = (p) => (p.absCol && p.absRow) ? `${p.absCol ? '$' : ''}${p.col}${p.absRow ? '$' : ''}${p.row}` : `${p.absCol ? '$' : ''}${idxToCol(mapCol(colToIdx(p.col)))}${p.absRow ? '$' : ''}${mapRow(p.row)}`;", mustRed: ['sheetop 引用重写'], msg: ['绝对引用也要移'] },
  { id: 'M228', file: D, only: 'sheetop', name: '不删 calcChain.xml（地址变了而计算链没变）——对账必须把旧链抓出来', find: "    if (name === 'xl/calcChain.xml') { calcChainDropped = true; return null; }", to: "    if (name === 'xl/calcChain.xml') { return data; }", mustRed: ['sheetop 引用重写'], msg: ['calcChain'] },
  { id: 'M229', file: D, only: 'sheetop', name: '公式改了却不清那格的缓存值（陈旧数会直接进 CSV／PDF）——缓存清理断言必须红', find: "    if (rw.changed && fm[3] !== '/>' && /<v>[\\s\\S]*?<\\/v>/.test(inner)) { inner = inner.replace(/<v>[\\s\\S]*?<\\/v>/g, ''); st.cacheCleared += 1; }", to: "    void rw.changed; // M229：缓存不清", mustRed: ['sheetop 引用重写'], msg: ['缓存值没清'] },
  { id: 'M230', file: D, only: 'sheetop', name: '引用位清单里漏掉 dimension（用过的范围不再随结构走）——dimension 判据必须红', find: "  const SITE = [['dimension', ['ref']], ['mergeCell', ['ref']],", to: "  const SITE = [['mergeCell', ['ref']],", mustRed: ['sheetop 引用重写'], msg: ['dimension'] },
  { id: 'M231', file: D, only: 'sheetop', name: '图表部件的匹配文件名打飞（系列缓存引用 <c:f> 整族不重写）——图表引用判据必须红', find: "    if (/^xl\\/charts\\/[^/]+\\.xml$/.test(name)) {", to: "    if (/^xl\\/chartsZZZ\\/[^/]+\\.xml$/.test(name)) {", mustRed: ['sheetop 引用重写'], msg: ['图表系列'] },
  { id: 'M232', file: D, only: 'sheetop', name: '命名域一律不改（打印区／标题行这类"别的部件也指着单元格"的引用被漏掉）——命名域判据必须红', find: "    if (!/[A-Za-z]/.test(txt) || !/!/.test(txt) || /#(REF|NAME|VALUE|DIV\\/0|NULL|NUM)!(?![A-Za-z])/.test(txt)) return { text: txt, changed: 0 };", to: "    return { text: txt, changed: 0 };", mustRed: ['sheetop 引用重写'], msg: ['命名域'] },
  { id: 'M233', file: D, only: 'sheetop', name: '把"结构化引用一律拒"那道闸拆掉（Table1[列] 被当普通文字混过去就是假成功）——拒收判据必须红', find: "    if (ch === '[' || ch === ']') throw new Error('公式里有结构化引用（Table1[列] 一类），引用重写不猜表语义');", to: "    if (false && (ch === '[' || ch === ']')) throw new Error('x');", mustRed: ['sheetop 引用重写'], msg: ['拒收（结构化引用）'] },
  { id: 'M234', file: D, only: 'sheetop', name: '区间只映射两个角、不取整段的像（移列时 A1:C7 被写成 A1:B7＝少一列）——包围盒判据必须红', find: "    const cand = [lo, hi].concat(sp).filter((v) => v >= lo && v <= hi);", to: "    const cand = [lo, hi];", mustRed: ['sheetop 引用重写'], msg: ['dimension'] },
  { id: 'M235', file: D, only: 'sheetop', name: '不再给 calcPr 补 fullCalcOnLoad（读方拿陈旧缓存当数，装置却报成功）——强制重算位判据必须红', find: '  const addFlag = (m0, at) => (/\\bfullCalcOnLoad="/.test(at) ? m0 : `<calcPr${at} fullCalcOnLoad="1"`);', to: '  const addFlag = (m0, at) => m0; // M235：干脆不补', mustRed: ['sheetop 引用重写'], msg: ['fullCalcOnLoad'] },
  { id: 'M236', file: 'test/mutant.js', only: '变异台写盘韧性', name: '把注入用的函数替换退回字符串替换（to 里含 $ 特殊序列时把源码拼坏）——韧性判据新增的子断言必须红；🔴 自指例：锚串在源码里用拼接断开，否则 split 会数到定义行那一处', find: "writeHard(p, text.replace(m.find, () => m.t" + "o), m.id", to: "writeHard(p, text.replace(m.find, m.to), m.id", mustRed: ['变异台写盘韧性'], msg: ['函数替换'] },
  // ---- v2.9.0（2026-10-14 性能优化与问题修复轮）：O1 测试产物重定向 / O3 freePath 单次 readdir / F6 输入体积闸 / O2 gc ----
  { id: 'M237', file: D, only: '产物根', name: 'selftest 只改父进程 OUT_DIR、不把 DOCKIT_OUT_DIR 传给子进程（判据 spawn 出去的装置进程照旧往 _out 沉＝本轮 858 件沉积的老形状）', find: "  ensureDir(OUT_DIR);\n  process.env.DOCKIT_OUT_DIR = OUT_DIR;", to: "  ensureDir(OUT_DIR); // M237：env 不外传", mustRed: ['产物根 OUT_DIR'], msg: ['子进程没继承'] },
  { id: 'M238', file: D, only: '产物根', name: '不设 env 时的默认落点从 _out 挪到 _tmp（装置默认行为被改＝承重"产物落点不许动"，调用方按 _out 找件会一件也找不到）', find: ": ROOT + '/_out';", to: ": ROOT + '/_tmp';", mustRed: ['产物根 OUT_DIR'], msg: ['没落进本仓 _out'] },
  { id: 'M239', file: D, only: 'readdir', name: 'freePath 列了目录却不查那个集合（号随便挑 ⇒ 发出去的路径可能已存在＝覆盖）', find: "  const taken = dirNamesOf(dir);\n  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}.${ext}`) && !fs.existsSync(`${dir}/${base}-${n}.${ext}`))", to: "  const taken = new Set(); // M239：集合是空的\n  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}.${ext}`) && !fs.existsSync(`${dir}/${base}-${n}.${ext}`))", mustRed: ['freePath/freeDir'], msg: ['没走单次 readdir'] },
  { id: 'M240', file: D, only: 'readdir', name: 'freePath 的"无占用一次探针"快路径不打条件（无条件把基名交出去＝典型场景直接覆盖第一个产物）', find: "  if (!fs.existsSync(first)) return first;\n  const taken = dirNamesOf(dir);\n  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}.${ext}`) && !fs.existsSync(`${dir}/${base}-${n}.${ext}`))", to: "  if (true) return first; // M240：快路径不打条件\n  const taken = dirNamesOf(dir);\n  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}.${ext}`) && !fs.existsSync(`${dir}/${base}-${n}.${ext}`))", mustRed: ['freePath/freeDir'], msg: ['一次探针'] },
  { id: 'M241', file: D, only: 'readdir', name: 'freeDir（目录形态产物那一侧）没跟着改、退回逐号 existsSync（同一条修法只做一半＝饱和名下 pages/render 那一族仍每次几百次 stat）', find: "  const taken = dirNamesOf(dir);\n  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`) && !fs.existsSync(`${dir}/${base}-${n}`))", to: "  let n = 2;\n  while (fs.existsSync(`${dir}/${base}-${n}`)) n += 1; // M241：这一侧没同步\n  return `${dir}/${base}-${n}`;", mustRed: ['freePath/freeDir'], msg: ['逐号 existsSync 循环'] },
  { id: 'M242', file: D, only: '输入体积闸', name: '体积闸只量不拒（st.size > cap 不打真值）——超限件照样整件读进内存，F6 那条"不落半成品"随之失守', find: "if (st.size > cap) die('input-too-large'", to: "if (false && st.size > cap) die('input-too-large'", mustRed: ['输入体积闸'], msg: ['没回 input-too-large'] },
  { id: 'M243', file: D, only: '输入体积闸,结构化命令面', name: '默认上限常量改成 268435455 而 help 的 default 字面量没跟着改（双写脱钩：调用方读到的上限是假的）——🔴 按台子纪律②弄坏数据、不删比较', find: "const MAX_INPUT_BYTES_DEFAULT = 268435456;\nconst GC_MIN_AGE_DAYS = 7;", to: "const MAX_INPUT_BYTES_DEFAULT = 268435455; // M243\nconst GC_MIN_AGE_DAYS = 7;", mustRed: ['输入体积闸', 'help 结构化命令面'], msg: ['256 MB 的字面量'] },
  { id: 'M244', file: D, only: '输入体积闸,结构化命令面', name: 'scrub 一族的闸漏调（宣告了 --max-input-bytes 却不读＝假闸，"一族都不许漏"这条就是为这一形状立的）', find: "  inputSizeGuard(positional[0], flags['max-input-bytes'], 'scrub');", to: "  void 0; // M244：这一族的闸摘了", mustRed: ['输入体积闸', 'help 结构化命令面'], msg: ['假闸'] },
  { id: 'M245', file: D, only: '回收面', name: 'gc 文件侧指纹过宽（任何文件都算装置产物）——人起的名字进了回收面＝误清，这条判据的 MUST_STAY 三面全该红', find: "(!isDir && (GC_STAMP_FILE_RE.test(name) || GC_BACKEND_TMP_RE.test(name)))", to: "(!isDir)", mustRed: ['回收面'], msg: ['误清'] },
  { id: 'M246', file: D, only: '回收面', name: 'gc 第二指纹失效（后端 .savetmp 事务残骸不再进面）——那一族正是"不由装置产生、只有机器会起的名"，漏掉它 _out 永远清不干净', find: "GC_BACKEND_TMP_RE.test(name)", to: "false", mustRed: ['回收面'], msg: ['没被搬走（原位置还在）'] },
  { id: 'M247', file: D, only: '回收面', name: 'gc 的 dry-run 默认翻成执行（不给 --yes 也搬文件）——这条命令唯一的安全面就是"默认不动手"，翻掉等于把回收变成事故', find: "const go = Boolean(flags.yes);", to: "const go = true; // M247", mustRed: ['回收面'], msg: ['dry-run'] },
  { id: 'M248', file: D, only: '回收面', name: 'gc 的 --age 下限摘回 0（允许"不按年龄过滤"）——_tmp 里正在跑的那一轮 selftest 目录同样带装置时间戳，会被整只扫进隔离区，装置自己给自己挖坑', find: "if (!Number.isInteger(age) || age < 1) die('invalid-output'", to: "if (!Number.isInteger(age) || age < 0) die('invalid-output'", mustRed: ['回收面'], msg: ['age 0 没被拒'] },
  { id: 'M249', file: D, only: '回收面', name: 'gc 的执行面把 renameSync 换成 rmSync（"可逆隔离"变成真删除）——机主口径：删除换成可逆隔离，这一刀必须当场红', find: "fs.renameSync(srcPath, dstPath);", to: "fs.rmSync(srcPath, { force: true }); // M249：直接删", mustRed: ['回收面'], msg: ['rmSync＝删除而非移动'] },
  { id: 'M250', file: D, only: '输入体积闸', name: 'combine 只拦第一路输入（收 2..N 份 PDF 的命令，第 2 份起照样整件 readFileSync 进内存——"一族都不许漏"里的"一路都不许漏"）', find: 'for (let gi = 0; gi < positional.length; gi += 1) inputSizeGuard(positional[gi], flags[\'max-input-bytes\'], `combine 第 ${gi + 1} 路输入`);', to: "if (positional.length) inputSizeGuard(positional[0], flags['max-input-bytes'], 'combine 第 1 路输入'); // M250：只拦头一路", mustRed: ['输入体积闸'], msg: ['第二路'] },
  { id: 'M251', file: D, only: '输入体积闸', name: 'merge 的数据件漏闸（模板拦住了、数据 JSON 仍整件读进内存；第三个位置参数是输出、不在闸面）', find: "  inputSizeGuard(positional[1], flags['max-input-bytes'], 'merge 的数据件'); // 🔴 F6 补口：数据 JSON 也是整件读进内存的输入（第三个位置参数是输出，不在闸面）", to: '  void 0; // M251：数据件这一路摘了', mustRed: ['输入体积闸'], msg: ['数据件'] },
  { id: 'M252', file: D, only: '回收面', name: '隔离区落点改为独立绝对路径（迁移到其他卷时 renameSync 会失败）', find: "const GC_QUARANTINE_ROOT = path.dirname(ROOT) + '/垃圾产物';", to: "const GC_QUARANTINE_ROOT = path.resolve('C:/__mutant__');", mustRed: ['回收面'], msg: ['跨卷形状会复辟'] },
  { id: 'M253', file: D, only: '回收面', name: '--exclude 检查摘掉（被排除的"真工件形状"照样进回收面）——2026-10-14 实测候选面里混着 12 件真交付件产物：装置签名只证明"不是人起的名字"，不证明"不是真工件"', find: 'if (exclude && exclude.length && exclude.some((pre) => name.startsWith(pre))) { excluded.push(name); continue; }', to: 'if (false && exclude && exclude.length && exclude.some((pre) => name.startsWith(pre))) { excluded.push(name); continue; }', mustRed: ['回收面'], msg: ['还是被搬走了'] },
  { id: 'M254', file: D, only: '回收面', name: '--exclude 给空清单不再拒（静默"什么都不排除"，调用方以为自己已经圈住了真工件）', find: "if (flags.exclude !== undefined && !exclude.length) die('invalid-output'", to: "if (false && flags.exclude !== undefined && !exclude.length) die('invalid-output'", mustRed: ['回收面'], msg: ['空清单没拒'] },
  { id: 'M255', file: 'test/char-baseline.js', only: '字符集基线台子', name: '「消失码点」计算打飞成恒空——零消失闸因此说不出任何事（基线与语料相同时真实消失本来就是 0，坏实现永远抓不到 ⇒ 判据必须用 --at 造一个已知消失来量）', find: 'const gone = [...bUse.set].filter((cp) => !all.has(cp)).sort((x, y) => x - y);', to: 'const gone = []; // M255：消失面恒空', mustRed: ['字符集基线台子'], msg: ['消失"这一面是坏的'] },
  { id: 'M256', file: 'test/char-baseline.js', only: '字符集基线台子', name: '--at 被静默忽略（照旧读原基线）——"对照另一份基线"是假的，读数还会与原基线混淆', find: '  if (atPath) {', to: '  if (false) {', mustRed: ['字符集基线台子'], msg: ['没自报对照的是哪份基线'] },
  // ---- v3.0.0（2026-10-14 自检自修轮）：四处"给了却静默生效不了"的形状，每修一处配一刀 ----
  { id: 'M257', file: D, only: 'readdir,freePath', name: 'freePath 只信 readdir 集合、不做 existsSync 复核（大小写错位的同名件在集合里查不到、却真实占用 ⇒ 发出去的路径＝覆盖承重 2）——v3.0.0 自检自修轮实抓的回归形状', find: '  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}.${ext}`) && !fs.existsSync(`${dir}/${base}-${n}.${ext}`))', to: '  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}.${ext}`))', mustRed: ['freePath/freeDir'], msg: ['大小写错位'] },
  { id: 'M258', file: D, only: 'readdir,freePath', name: 'freeDir 只信 readdir 集合、不做 existsSync 复核（与 M257 同族的目录形态那一侧）', find: '  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`) && !fs.existsSync(`${dir}/${base}-${n}`))', to: '  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`))', mustRed: ['freePath/freeDir'], msg: ['大小写错位'] },
  { id: 'M259', file: D, only: '输入体积闸', name: '--max-input-bytes 非法值校验整个摘掉（非整数照旧静默回退默认、0 会错判成 input-too-large——"写了值等于没写"的放宽）', find: "    if (!Number.isInteger(v) || v < 1) die('invalid-output',", to: "    if (false) die('invalid-output',", mustRed: ['输入体积闸'], msg: ['没被拒'] },
  { id: 'M260', file: D, only: '回收面', name: 'gc --base 空/纯空白不再拒（静默"不过滤"，调用方以为自己圈住了子集）', find: "  if (flags.base !== undefined && !String(flags.base).trim()) die('invalid-output',", to: "  if (false && flags.base !== undefined && !String(flags.base).trim()) die('invalid-output',", mustRed: ['回收面'], msg: ['没被拒'] },
  { id: 'M261', file: 'test/char-baseline.js', only: '字符集基线台子', name: '--at 缺值守卫摘掉（缺值/后跟开关会被当成路径又报"文件不在"，方向不清；静默形状复辟）', find: "  if (atIdx >= 0 && (!argv[atIdx + 1] || String(argv[atIdx + 1]).startsWith('--')))", to: "  if (false && atIdx >= 0 && (!argv[atIdx + 1] || String(argv[atIdx + 1]).startsWith('--')))", mustRed: ['字符集基线台子'], msg: ['缺值'] },
  // ---- v3.1.0（2026-10-15 外部审查报告处理轮）：redact 三件每修一处配一刀 ----
  { id: 'M262', file: D, only: 'redact 真涂黑', name: '--fill 开关整个摘掉（fill 恒为 black＝删字留白出口消失，"脱敏与删内容捆死"的旧形状复辟）', find: "  const fill = flags.fill !== undefined && flags.fill !== null ? String(flags.fill).toLowerCase() : 'black';", to: "  const fill = 'black'; // M262：开关摘了", mustRed: ['redact 真涂黑'], msg: ['--fill none 正向没跑通'] },
  { id: 'M263', file: D, only: 'redact 真涂黑', name: '删多统计整个摘掉（outsidePts 不再进 crossOps＝删多静默，"验收只防删漏不防删多"的老形状复辟）', find: '          if (outsidePts.length) crossOps.push({ page: pageNum, outsidePts: outsidePts.length });', to: '          void outsidePts; // M263：统计摘了', mustRed: ['redact 真涂黑'], msg: ['删多预警没响'] },
  { id: 'M264', file: D, only: 'redact 真涂黑', name: '旋转页前置守卫摘掉（/Rotate≠0 的件照跑＝按错误映射删错字/删不动，v3.1.0 实测坐标失配的旧形状复辟）', find: "    if (rotatedPages.length && !dryRun) die('unsupported-format',", to: "    if (false && rotatedPages.length && !dryRun) die('unsupported-format',", mustRed: ['redact 真涂黑'], msg: ['旋转页该前置拒'] },
  { id: 'M265', file: D, only: 'redact 真涂黑', name: '括号感知切分换回旧非贪婪正则（字符串字面量 TARGET 的 ET 截断复现＝删块边界失配，v2.7.0 起的老缺陷）', find: '        for (const [bs, be] of findTextBlocks(s).reverse()) {', to: '        for (const bs of [0]) { const be = s.length; void findTextBlocks;', mustRed: ['redact 真涂黑'], msg: ['该留的文字也弄丢了'] },
  { id: 'M266', file: D, only: 'redact 真涂黑', name: '--dry-run 试运行分支摘掉（预览变真跑＝删字画框落盘，试运行零写入形状复辟）', find: '    if (dryRun) {', to: '    if (false) { // M266：试运行分支摘掉', mustRed: ['redact 真涂黑'], msg: ['dry-run 正向没跑通'] },
  { id: 'M267', file: 'install-skill.js', only: '安装器与基线台输出不回显绝对路径', name: '路径占位摘掉（最长前缀折叠不跑＝输出回吐裸绝对路径，粘贴即泄用户名）', find: '  if (cands.length) { cands.sort((a, b) => b[0].length - a[0].length); s = cands[0][1] + s.slice(cands[0][0].length); }', to: '  if (false && cands.length) { cands.sort((a, b) => b[0].length - a[0].length); s = cands[0][1] + s.slice(cands[0][0].length); }', mustRed: ['安装器与基线台输出不回显绝对路径'], msg: ['绝对路径'] },
  { id: 'M268', file: D, only: 'substitute-fonts', name: '字体哈希比对摘掉（同名异容照绿＝"核全量"是空话，doctor 全绿≠字体正确）', find: '        if (!h || h.toLowerCase() !== String(x.sha256).toLowerCase()) badHash.push(x.name);', to: '        if (false) badHash.push(x.name); // M268：哈希比对摘掉', mustRed: ['substitute-fonts 哨兵按登记清单核全量'], msg: ['同名异容没判红'] },
  // ---- CI 首绿轮（2026-10-16）：覆盖率闸口径改成"按归因分流"后，**新分支自己**的牙。
  //      M106 打的是"未声明 ⇒ 缺失态必红 ⇒ failed≠控制组"那条路；本例打的是"已声明 ⇒ 被洗成 SKIP ⇒ 只能靠集合对账"那条路。
  //      🔴 注入形状必须是**不新增判据**（新建一条 t() 会先改判据定义数、把「doc 卫生」打红，闸门就走成 failed≠控制组 分支，
  //      本例就测不到新分支了——第一版实犯）：把一条**不在注册表里**的静态判据改成「声明 {needs:'kit'} 且恒失败」，
  //      它在缺失态被洗成 kit 归因的 SKIP、名字又不在注册表 ⇒ 只有新分支能抓它（missing 为空，旧集合口径与新分支都红，
  //      但红因文本只有新分支才带「吃 kit 却未登记的」）。
  { id: 'M269', file: D, only: '依赖覆盖率闸', name: 'CI 首绿轮：把一条**不在注册表里**的静态判据改成「声明 {needs:kit} 且恒失败」——它被洗成 SKIP、不进 failed≠控制组那条路，必须由「吃 kit 却未登记」新分支抓红', find: "t('v3 版本迭代位规则未被违反：大版本为机主批准的 3（机主 2026-10-14 令「版本号升 3.0.0」；AI 不得自升 X）', () => VERSION.startsWith('3.'));", to: "t('v3 版本迭代位规则未被违反：大版本为机主批准的 3（机主 2026-10-14 令「版本号升 3.0.0」；AI 不得自升 X）', () => false, {needs:'kit'});", mustRed: ['依赖覆盖率闸'], msg: ['吃 kit 却未登记的'] },
];

const argv = process.argv.slice(2);
if (argv.includes('--list')) { for (const m of MUTANTS) console.log(`${m.id} [${m.file}] 只跑(${m.only}) → 弄坏：${m.name} ｜ 应变红：${m.mustRed.join(' / ')}${m.msg ? ' ｜ 红因须含：' + m.msg.join(' / ') : ''}`); process.exit(0); }
const forcePublic = argv.includes('--public');
const requestedIds = argv.filter((a) => /^M\d+$/.test(a));
const unknownArgs = argv.filter((a) => a !== '--public' && !/^M\d+$/.test(a));
const unknownIds = requestedIds.filter((id) => !MUTANTS.some((m) => m.id === id));
if (unknownArgs.length || unknownIds.length) {
  console.log(JSON.stringify({ ok: false, code: 'invalid-mutant-args', unknown: [...unknownArgs, ...unknownIds], next: '使用 --list、--public 或已登记的变异编号（M1–M269）' }, null, 1));
  process.exit(2);
}
const requested = requestedIds.length ? MUTANTS.filter((m) => requestedIds.includes(m.id)) : MUTANTS;
const missingTargets = requested.filter((m) => !fs.existsSync(path.join(ROOT, m.file)));
const publicOnly = forcePublic || (!requestedIds.length && missingTargets.length > 0);
if (requestedIds.length && missingTargets.length) {
  console.log(JSON.stringify({ ok: false, code: 'missing-mutant-targets', missing: missingTargets.map((m) => ({ id: m.id, file: m.file })), next: '该变异依赖未随公开仓分发的内部文件；请在完整工作树中运行' }, null, 1));
  process.exit(2);
}
const picked = publicOnly ? requested.filter((m) => fs.existsSync(path.join(ROOT, m.file))) : requested;
if (!publicOnly && missingTargets.length) {
  console.log(JSON.stringify({ ok: false, code: 'missing-mutant-targets', missing: missingTargets.map((m) => ({ id: m.id, file: m.file })), next: '公开克隆请用 node test/mutant.js --public；该模式会排除未随公开仓分发的内部文档靶' }, null, 1));
  process.exit(2);
}
if (publicOnly) console.log('公开子集：可见靶 ' + picked.length + '/' + requested.length + ' 例；排除 ' + missingTargets.length + ' 个缺失靶文件');

fs.mkdirSync(path.join(ROOT, '_tmp'), { recursive: true });

// 预检⑤：mustRed 必须是"本例 only 真能选中的某条判据名"的子串，否则这条变异永远不可能 HIT，
// 台子会把它报成"判据没牙"——那是判台子坏了去改判据，方向正好反了（v1.1.1 实犯：M10 的 mustRed 写成了没被选中的判据）。
const NAMES = [...fs.readFileSync(path.join(ROOT, D), 'utf8').matchAll(/^[ \t]*(?:await[ \t]+)?(?:ta|t)\(\s*'([^']+)'/gm)].map((x) => x[1]);
const preflight = [];
for (const m of picked) {
  const toks = String(m.only || '').split(',').map((s) => s.trim()).filter(Boolean);
  const sel = toks.length ? NAMES.filter((n) => toks.some((o) => n.includes(o))) : NAMES;
  if (!sel.length) preflight.push(`${m.id}: 选跑集合 "${m.only}" 一条判据都没选中（判据名按子串匹配，共 ${NAMES.length} 条可查）`);
  const miss = (m.mustRed || []).filter((n) => !sel.some((s) => s.includes(n)));
  if (miss.length) preflight.push(`${m.id}: mustRed 无法被本例选中 ⇒ ${miss.join(' / ')}`);
}
if (preflight.length) { console.error('🔴 台子预检失败，变异一个都没跑（先修台子，别改判据）：\n  ' + preflight.join('\n  ')); process.exit(2); }

const touched = new Map();
for (const m of picked) if (!touched.has(m.file)) { const p = path.join(ROOT, m.file); touched.set(p, fs.readFileSync(p)); fs.writeFileSync(path.join(ROOT, `_tmp/mutant-bak-${m.file.replace(/[^\w.-]/g, '_')}-${md5(Buffer.from(m.file)).slice(0, 8)}`), touched.get(p)); } // v2.7.0：CJK 名会被 sanitize 撞车（项目总览/迭代日志同为 ____），加路径哈希后缀保证「一文件一备份」
// env 通道自己的预检（不落产物、不改文件，只跑一发未变异态）：返回 true 才算这条注入通道有牙。
function envPreflight(m) {
  const r = spawnSync(process.execPath, [path.join(ROOT, D), 'selftest', '--only=' + m.only], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT, timeout: 420000, env: { ...process.env, ...SAFE_BACKEND_ENV, ...m.env },
  });
  let j = null; try { j = JSON.parse(r.stdout); } catch { return `未变异态在该 env 下跑不出 JSON：${String(r.stdout || r.stderr).slice(0, 90)}`; }
  if ((j.failed || 0) !== 0) {
    const firstRed = (j.checks || []).filter((c) => c.startsWith('FAIL'))[0] || '';
    return `未变异态在该 env 下就是红的（FAIL=${j.failed}）：${firstRed.slice(0, 120)} —— 先修实现再来打变异`;
  }
  const sk = (j.checks || []).filter((c) => c.startsWith('SKIP'));
  if (!sk.some((c) => c.includes(m.mustRed[0]))) return `目标判据在该 env 下没报 SKIP ⇒ env 没落到子进程（现 SKIP=${sk.map((s) => s.slice(5, 34)).join(' / ') || '无'}）`;
  return true;
}

// 🔴 基线红前置（v1.6.7 监工侧加；机主 2026-10-07 裁 P-4 改判要做）。实犯形状：这台机器基线红 2 条时，
//    mustRed 指着那两条的 7 例（M91–M94、M106–M108）不注入也"红"、注入了也判 OK，两遍都报 `OK 107，BAD 0`。
//    一条红 ⇒ 一批假绿，比没变异更坏（弱变异）。做法＝先跑一发**未变异全量**（约 85 秒）取基线红名单；
//    某例的 mustRed 命中名单 ⇒ 判 BASELINE-RED（计入 BAD、退码非零）——这一例今天说不出话，别冒充有牙。
let baseRedNames = [];
let baseSkipNames = [];
{
  const r0 = spawnSync(process.execPath, [path.join(ROOT, D), 'selftest'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT, timeout: 600000, env: { ...process.env, ...SAFE_BACKEND_ENV } });
  let j0 = null; try { j0 = JSON.parse(r0.stdout); } catch {}
  if (!j0) { console.error('🔴 基线预检：未变异全量 selftest 跑不出 JSON，台子不出结论'); process.exit(2); }
  baseRedNames = (j0.checks || []).filter((c) => c.startsWith('FAIL')).map((c) => c.slice(5, c.indexOf(' :: ') < 0 ? undefined : c.indexOf(' :: ')));
  baseSkipNames = (j0.checks || []).filter((c) => c.startsWith('SKIP')).map((c) => c.slice(5, c.indexOf(' :: ') < 0 ? undefined : c.indexOf(' :: ')));
  if (baseRedNames.length) {
    console.error('🔴 基线预检：未变异态就有 ' + baseRedNames.length + ' 条红 ⇒ mustRed 指着它们的变异例今天说不出结论（判 BASELINE-RED）：');
    for (const n of baseRedNames) console.error('   · ' + n.slice(0, 70));
  }
}
const rows = []; let ok = 0, skipped = 0, bad = 0, baseRedCut = 0, selEmpty = 0;
// ---- CI 首绿轮（2026-10-16）：例所需**能力**探针（UNAVAILABLE-CAPABILITY）。
//      有的判据在本机缺某个可选前置时会走**诚实降级分支**并 PASS（不是 SKIP）：这时"目标判据没 SKIP"
//      说明不了本机有那能力，变异也就打不出红——CI 实测两例（M169 无 tesseract ⇒ pipeline 的 ocr 子断言
//      根本不跑；M182 无 pdfform 的单体 CJK 字体 ⇒ 判据只断言回 unavailable 就 PASS）。这类例声明
//      needsCap，本机没这能力就报「说不出结论」，与 UNAVAILABLE-SKIP 同族：**不冒充 BAD，也不冒充 OK**。
//      🔴 探针必须与判据**同源**：字体候选表从 dockit.js 现抽（抽不动就按"说不出结论"处理——宁可不结论，不冒充）。
function dockitFontCandidates() {
  const src = fs.readFileSync(path.join(ROOT, D), 'utf8');
  const m = /const PDFFORM_FONT_CANDIDATES = \[([^\]]*)\]/.exec(src);
  if (!m) return [];
  try { return new Function('return [' + m[1] + ']')(); } catch { return []; }
}
const TESSERACT_EXE_FOR_CAP = () => (process.env.DOCKIT_TESSERACT || path.join(process.env.DOCKIT_TESSERACT_DIR || 'C:\\Program Files\\Tesseract-OCR', 'tesseract.exe'));
const CAP_PROBES = {
  tesseract: () => fs.existsSync(TESSERACT_EXE_FOR_CAP()),
  cjkFormFont: () => dockitFontCandidates().some((p) => fs.existsSync(p)),
};
const CAP_WHY = {
  tesseract: '本机无 tesseract：判据里的 ocr 子断言不跑（走可选分支），掏空 ocr 步的变异打不出红',
  cjkFormFont: '本机没有 pdfform 的单体 CJK 字体（字体面缺件）：判据走诚实降级分支，掏空 setText 打不出红',
};
try {
  for (const m of picked) {
    const unavailable = !m.env ? m.mustRed.filter((n) => baseSkipNames.some((s) => s.includes(n))) : [];
    if (unavailable.length) {
      skipped++;
      rows.push({ id: m.id, name: m.name, verdict: `UNAVAILABLE-SKIP（基线 selftest 的目标判据为 SKIP：${unavailable.join(' / ')}）` });
      continue;
    }
    if (m.needsCap) {
      const probe = CAP_PROBES[m.needsCap];
      if (!probe) { bad++; rows.push({ id: m.id, name: m.name, verdict: `CAP-UNKNOWN（台子没登记 needsCap="${m.needsCap}" 这个能力名——先修台子）` }); continue; }
      if (!probe()) { skipped++; rows.push({ id: m.id, name: m.name, verdict: `UNAVAILABLE-CAPABILITY（${CAP_WHY[m.needsCap] || m.needsCap}）` }); continue; }
    }
    const p = path.join(ROOT, m.file);
    const orig = touched.get(p);
    // 🔴 CI 首绿轮：锚点必须与**行尾符无关**。CI 的 checkout 是 CRLF（Windows runner 的 core.autocrlf=true），
    //    而多行锚点里写的是 \n —— 整条变异会静默变成 ANCHOR-MISS（CI 实测 20 例；本机工作树是 LF 所以全绿，
    //    2026-10-16 用 CRLF 副本逐锚点复现，24 例丢锚与 CI 名单逐字对上）。这里统一按 LF 匹配与注入；
    //    收尾仍写回**原始字节**（orig），md5 还原对账不受影响。
    const text = orig.toString('utf8').replace(/\r\n/g, '\n');
    const hits = text.split(m.find).length - 1;
    if (hits === 0) { bad++; rows.push({ id: m.id, verdict: 'ANCHOR-MISS（变异没打进去，不算红）' }); continue; }
    if (hits > 1) { bad++; rows.push({ id: m.id, verdict: `ANCHOR-AMBIGUOUS（锚点命中 ${hits} 处，拒绝跑）` }); continue; }
    // v1.6.1：按例注入 env 的通道（M100 用）——"缺后端才触发"的守卫只能在注入环境下打红，
    // 而这条通道自己的牙由 envPreflight 先验：未变异态在该 env 下必须"不红且目标判据报 SKIP"，
    // 否则 env 没落到子进程，"守卫拆掉也不红"会被误读成"判据没牙"（M94 同族教训）。
    const pollutedNames = m.mustRed.filter((n) => baseRedNames.some((b) => b.includes(n)));
    if (pollutedNames.length) { bad++; baseRedCut++; rows.push({ id: m.id, name: m.name, verdict: `BASELINE-RED（mustRed 指着基线就红的条：${pollutedNames.join('、')}）——本例今天说不出结论，先修基线红再来` }); continue; }
    if (m.env) { const pr = envPreflight(m); if (pr !== true) { bad++; rows.push({ id: m.id, name: m.name, verdict: `ENV-PREFLIGHT（${pr}）——env 通道没牙，本例不出结论，先修台子` }); continue; } }
    if (!writeHard(p, text.replace(m.find, () => m.to), m.id + ' 注入变异')) { rows.push({ id: m.id, verdict: 'INJECT-LOCKED（变异写不进去，台子停下——继续跑等于拿未变异态出结论）' }); bad++; throw new Error('注入阶段文件锁打穿重试，停下还原'); }
    const started = Date.now();
    let r = spawnSync(process.execPath, [path.join(ROOT, D), 'selftest', '--only=' + m.only], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT, timeout: 420000, env: { ...process.env, ...SAFE_BACKEND_ENV, ...(m.env || {}) } });
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    // CJK 的 --only 值走 Windows argv 偶发变形（实犯：M59 两遍里有一遍选中 0 条 ⇒ 误判"未变红"）。
    // 只补这一种抖动，不改判定口径：重试后仍 0 条 ⇒ 下面 SELECT-EMPTY 单列『不出结论』，既不冒充绿，也不再冤枉装置。
    for (let tries = 0; j && (j.passed || 0) + (j.failed || 0) + (j.skipped || 0) === 0 && tries < 3; tries++) {
      const rr = spawnSync(process.execPath, [path.join(ROOT, D), 'selftest', '--only=' + m.only], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT, timeout: 420000, env: { ...process.env, ...SAFE_BACKEND_ENV, ...(m.env || {}) } });
      // 🔴 v1.7.1：`r` 必须跟着换成本次读数。旧代码只换 `j` 不换 `r`，于是『第一发被 argv 抖动吞了、
      // 重试那一发真跑成了』这种组合会拿**第一发的退码 0** 去判 `r.status === 1` ⇒ 报成 BAD，
      // 而 未变红／红因缺失／意外红 三面全空——读起来像『装置没牙』，其实是台子把两发的字段拼错了。
      // 2026-10-08 用一次性副本强制 `--only` 变形复现过这一形状（见迭代日志 v1.7.1 补记）。
      r = rr;
      try { j = JSON.parse(rr.stdout); } catch {}
    }
    if (!writeHard(p, orig, m.id + ' 本例还原')) { rows.push({ id: m.id, verdict: 'REVERT-LOCKED（还原打穿重试——立即停止后续例，脏文件由 finally 再试一次）' }); bad++; throw new Error('还原阶段文件锁打穿重试'); }
    if (r.signal === 'SIGTERM' || !j) { bad++; rows.push({ id: m.id, verdict: 'RUN-INCOMPLETE（超时或非 JSON 输出，不出结论；预算 420s——被顶到 SIGTERM 通常是选跑集合里混进了引擎调用并撞上引擎自己的超时）', 用时秒: +((Date.now() - started) / 1000).toFixed(1), signal: r.signal, head: String(r.stdout || r.stderr).slice(0, 160) }); continue; }
    // v1.7.1 补：重试三次之后选跑集合还是 0 条 ⇒ 这是**台子自己没跑成**，不是『判据没牙』。
    // 旧口径把它落进下面的 BAD（2026-10-08 全量第二遍的 M58 实犯：单跑四遍全 OK 且 ran=1，
    // 那一遍却报『未变红』）——与 ANCHOR-MISS／BASELINE-RED／ENV-PREFLIGHT 同族，必须另判：
    // 仍然计入非零退码（绝不让它冒充绿），但结论面写『不出结论』，免得把人指去查装置代码。
    if ((j.passed || 0) + (j.failed || 0) + (j.skipped || 0) === 0) {
      bad++; selEmpty++;
      rows.push({ id: m.id, name: m.name, 用时秒: +((Date.now() - started) / 1000).toFixed(1), 只跑: m.only, verdict: 'SELECT-EMPTY（重试三次后 `--only` 仍选中 0 条——值走 Windows argv 变形；本例不出结论，先查台子再查装置）' });
      continue;
    }
    const red = (j.checks || []).filter((c) => c.startsWith('FAIL')).map((c) => c.slice(5));
    const missed = m.mustRed.filter((n) => !red.some((c) => c.includes(n)));
    const missedMsg = (m.msg || []).filter((n) => !red.some((c) => c.includes(n)));   // msg＝红因原文里的词，只可能来自消息
    const ran = (j.passed || 0) + (j.failed || 0) + (j.skipped || 0);
    const unexpected = red.filter((c) => !m.mustRed.some((n) => c.includes(n)) && !(m.msg || []).some((n) => c.includes(n)));
    const good = !missed.length && !missedMsg.length && r.status === 1 && ran > 0 && (m.blast || !unexpected.length);
    if (good) ok++; else bad++;
    rows.push({ id: m.id, name: m.name, 用时秒: +((Date.now() - started) / 1000).toFixed(1), 跑了判据数: ran, 只跑: m.only, 应变红: m.mustRed, 应带红因: m.msg || [], 实际红: red.map((c) => c.slice(0, 180)), 未变红: missed, 红因缺失: missedMsg, 意外红: m.blast ? '(blast 允许连带红)' : unexpected, verdict: good ? 'OK' : 'BAD' });
  }
} finally {
  // 🔴 v2.7.0：结论**先落 stdout**，再做收尾还原——旧顺序下一次锁异常就把整轮 221 例的读数吞掉（2026-10-14 实犯）。
  console.log(JSON.stringify(rows, null, 1));
  for (const [p, buf] of touched) writeHard(p, buf, '收尾还原');
  const mism = [...touched.entries()].filter(([p, buf]) => md5(fs.readFileSync(p)) !== md5(buf)).map((p) => p[0]);
  console.log(`\n变异 ${picked.length} 例：OK ${ok}，SKIP ${skipped}，BAD ${bad}${baseRedCut ? `（其中 ${baseRedCut} 例 BASELINE-RED＝基线有红，说不出话）` : ''}${selEmpty ? `＋${selEmpty} 例 SELECT-EMPTY＝选跑集合被 argv 吞掉，本例不出结论` : ''}`);
  console.log(mism.length ? `🔴 还原失败：${mism.join(' , ')} —— 立即从 _tmp/mutant-bak-* 恢复再查` : '还原对账：全部触碰文件逐字节一致（md5）');
  process.exit(bad || mism.length ? 1 : 0);
}
