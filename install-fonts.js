#!/usr/bin/env node
'use strict';
// install-fonts.js — 字体装载器：把本仓登记的字体清单（test/font-manifest.json）装进系统字体目录，
// 一条命令完成"检测 → 装载 → 验证"，并让 doctor 的替身字体哨兵（substitute-fonts-present）转绿。
//
// 用法：
//   node install-fonts.js                # 检测缺失 → 从备份/清单源装载 → 复验
//   node install-fonts.js --list         # 只列出缺失清单，不装
//   node install-fonts.js --source <目录> # 显式指定字体源目录（默认按清单"来源"字段或环境变量 DOCKIT_FONT_SOURCE）
//   node install-fonts.js --check        # 只复验不装（等同 doctor 的那条哨兵）
//
// 前提与边界：
// - 写系统字体目录（C:\Windows\Fonts）需要**管理员权限**——无权限时如实报错，不静默降级。
// - 字体源目录由机主侧持有（清单"来源"字段指向备份目录的 manifest.csv）；公开仓不携带字体二进制
//  （字体文件有各自版权，仓库只登记名字与校验）。缺源时本脚本报"缺源+指路"，不冒充装载。
// - 装载方式按 Windows 惯例：copyfile 进字体目录 + 注册表登记（HKLM\...\Fonts）；无注册表权限时报错。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function fontDir() {
  return process.env.SystemRoot ? path.join(process.env.SystemRoot, 'Fonts') : 'C:\\Windows\\Fonts';
}

function readManifest() {
  const p = process.env.DOCKIT_FONT_MANIFEST || path.join(ROOT, 'test', 'font-manifest.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { err: String(e.message || e) }; }
}

function isAdmin() {
  if (process.platform !== 'win32') return null;
  try { spawnSync('fltmc', [], { stdio: 'ignore' }); return spawnSync('fltmc', []).status === 0; }
  catch { return false; }
}

function main(argv) {
  const a = { list: false, check: false, source: process.env.DOCKIT_FONT_SOURCE || null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') a.list = true;
    else if (argv[i] === '--check') a.check = true;
    else if (argv[i] === '--source') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.log(JSON.stringify({ ok: false, op: 'install-fonts', code: 'invalid-args', error: '--source 缺值', next: '用 --source <目录> 指定字体备份目录' }));
        process.exitCode = 1;
        return;
      }
      a.source = value;
      i++;
    }
  }
  const man = readManifest();
  if (man.err) { console.log(JSON.stringify({ ok: false, op: 'install-fonts', error: '清单读不到：' + man.err }, null, 1)); process.exit(1); }
  if (!Array.isArray(man.files) || !man.files.length) { console.log(JSON.stringify({ ok: false, op: 'install-fonts', error: '清单里没有 files 条目' }, null, 1)); process.exit(1); }

  const fd = fontDir();
  // 哈希验证：文件名在位不等于内容正确——同名异容的字体（版本不同/被替换）会被文件名检查放过去。
  // 清单带 sha256 的条目逐个对内容；不带 sha256 的条目只按文件名（如实自报"未验哈希"）。
  const crypto = require('crypto');
  const shaOf = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
  const inPlace = man.files.filter((x) => fs.existsSync(path.join(fd, x.name)));
  const hashMismatch = inPlace.filter((x) => x.sha256 && shaOf(path.join(fd, x.name)) !== String(x.sha256).toLowerCase());
  const verified = inPlace.filter((x) => x.sha256 && shaOf(path.join(fd, x.name)) === String(x.sha256).toLowerCase()).length;
  const miss = man.files.filter((x) => !fs.existsSync(path.join(fd, x.name)));

  if (a.list || a.check) {
    // --list 是纯信息探针；--check 在缺件或哈希不一致时必须失败（退码非 0）。
    const ok = a.list || (miss.length === 0 && hashMismatch.length === 0);
    console.log(JSON.stringify({ ok, op: 'install-fonts', mode: a.list ? 'list' : 'check', fontDir: fd, manifestCount: man.files.length, missing: miss.length, missingNames: miss.slice(0, 12).map((x) => x.name), hashVerified: verified, hashMismatch: hashMismatch.length, hashMismatchNames: hashMismatch.slice(0, 8).map((x) => x.name), note: miss.length ? '缺件从机主侧字体备份装载（--source <目录>，目录结构 = 清单"来源"字段）；写系统目录需管理员权限' : (hashMismatch.length ? `🔴 ${hashMismatch.length} 件在位但内容与清单 sha256 不一致（同名异容，可能是被替换/版本不同）——退出码非 0；修复 = 从机主侧备份重装（--source <目录>）` : '全在位且哈希一致'), hashNotCovered: man.files.length - verified - hashMismatch.length - miss.length }, null, 1));
    process.exit(ok ? 0 : 1);
  }

  // 装载面
  const source = a.source || (man['来源'] && !/^<.+>$/.test(man['来源']) ? man['来源'] : null);
  if (!source || !fs.existsSync(source)) {
    console.log(JSON.stringify({ ok: false, op: 'install-fonts', error: `缺字体源：清单"来源"字段是泛化占位（公开仓不携带字体二进制）；用 --source <目录> 指向机主侧字体备份（结构 = manifest.csv 同目录的字体文件）`, missing: miss.length, manifestCount: man.files.length }, null, 1));
    process.exit(1);
  }
  if (process.platform !== 'win32') { console.log(JSON.stringify({ ok: false, op: 'install-fonts', error: '本装载器只支持 Windows（写系统字体目录 + HKLM 登记）；其它平台请按各发行版方式手动装' }, null, 1)); process.exit(1); }
  const admin = isAdmin();
  if (admin === false) { console.log(JSON.stringify({ ok: false, op: 'install-fonts', error: '写系统字体目录需要管理员权限——用管理员身份重跑本命令', missing: miss.length }, null, 1)); process.exit(1); }

  // 装载面：复制后必须**逐条验 sha256**（清单每条都带 bytes+sha256）——同名异容的字体放过去等于没装对。
  const installed = [], stillMissing = [], failed = [], copiedHashBad = [];
  for (const x of miss) {
    const src = path.join(source, x.name);
    if (!fs.existsSync(src)) { failed.push({ name: x.name, why: '源目录里没有这个文件' }); continue; }
    try {
      const gotSha = shaOf(src);
      if (x.sha256 && gotSha !== String(x.sha256).toLowerCase()) { failed.push({ name: x.name, why: `源文件 sha256 与清单不一致（源=${(gotSha || '').slice(0, 12)}… 清单=${String(x.sha256).slice(0, 12)}…）` }); continue; }
      if (typeof x.bytes === 'number' && fs.statSync(src).size !== x.bytes) { failed.push({ name: x.name, why: `源文件字节数与清单不一致（源=${fs.statSync(src).size} 清单=${x.bytes}）` }); continue; }
      fs.copyFileSync(src, path.join(fd, x.name));
      // 复制后回读验证：目标文件的内容必须与清单逐字节一致
      const dstSha = shaOf(path.join(fd, x.name));
      if (x.sha256 && dstSha !== String(x.sha256).toLowerCase()) { copiedHashBad.push(x.name); continue; }
      // HKLM 登记（字体注册；失败不算装载失败——部分字体由 Windows 自动发现，但如实报告）
      const reg = spawnSync('reg', ['add', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', '/v', (x.name.replace(/\.ttf$/i, ' (TrueType)')), '/t', 'REG_SZ', '/d', x.name, '/f'], { stdio: 'ignore' });
      installed.push({ name: x.name, registered: reg.status === 0, hashVerified: true });
    } catch (e) { failed.push({ name: x.name, why: String(e.message || e).slice(0, 120) }); }
  }
  const after = man.files.filter((x) => !fs.existsSync(path.join(fd, x.name)));
  // 最终结果纳入**全部**不满足项：缺件、装载失败、复制后哈希不匹配、以及**已在位但内容不对**的（装不动它们
  // 但不许报成功——"同名异容会被拒绝"才成立）。
  const finalBad = after.length + failed.length + copiedHashBad.length + hashMismatch.length;
  console.log(JSON.stringify({ ok: finalBad === 0, op: 'install-fonts', fontDir: fd, manifestCount: man.files.length, installed: installed.length, hashVerifiedCopies: installed.length, copiedHashBad, registered: installed.filter((x) => x.registered).length, failed: failed.length, failedNames: failed.slice(0, 8), stillMissing: after.length, inPlaceHashMismatch: hashMismatch.length, inPlaceHashMismatchNames: hashMismatch.slice(0, 8).map((x) => x.name), verify: `node install-fonts.js --check（哈希复验）+ node dockit.js doctor（substitute-fonts-present 应转 PASS）` }, null, 1));
  process.exit(finalBad === 0 ? 0 : 1);
}

main(process.argv.slice(2));
