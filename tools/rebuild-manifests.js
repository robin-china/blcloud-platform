#!/usr/bin/env node
/* 重建静态兜底清单（updates/<产品>/latest.json、products.json、latest.json）
 *
 * 为什么需要单独一个脚本：
 *   静态清单是「发布版本那一刻」写出来的。加签、改字段这类代码上线后，
 *   旧文件不会自动重生成，于是出现「动态接口已带 signature，静态兜底还是老格式」，
 *   留了一条不用验签就能装包的旁路。部署完跑一次这个脚本即可。
 *
 * 用法：
 *   node tools/rebuild-manifests.js                        # 用 PUBLIC_BASE_URL 或后台「站点地址」
 *   node tools/rebuild-manifests.js https://www.bliot.cn/platform   # 显式指定
 *
 * 只读库、只写 data/updates 下的 JSON，不动安装包本身。
 */
const release = require('../server/lib/release');

function main() {
  const arg = String(process.argv[2] || '').trim().replace(/\/+$/, '');
  const base = arg || release.siteBase('');
  if (!base) {
    console.error('✗ 没有站点地址：请传参，或设置 PUBLIC_BASE_URL，或在后台「版本发布 → 站点地址」里填。');
    console.error('  不填的话会写出相对路径的下载地址，客户端拼不出完整 URL。');
    process.exit(1);
  }

  const before = release.staleManifests();
  console.log('站点地址:', base);
  console.log('缺签名的清单:', before.files.length ? before.files.join('、') : '（无）');

  const body = release.writeLatest(base);
  const info = release.getLastWriteInfo();

  // 写完立即自检：三份文件都必须带 signature / kid
  const all = release.staleManifests();
  console.log('已写入:', info.files.join('、'));
  console.log('默认产品最新版:', body.latest || '（无版本）');
  if (all.files.length) {
    console.error('✗ 重建后仍有清单缺签名:', all.files.join('、'));
    process.exit(2);
  }
  console.log('✓ 全部清单已带 Ed25519 签名');
}

main();
