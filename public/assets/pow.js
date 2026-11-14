/* 登录 PoW：前后端共用同一份算法（UMD）。
 * 服务端 require('../../public/assets/pow.js')，浏览器挂 window.AdminPow。
 * 刻意不依赖 Web Crypto：subtle.digest 是异步的，循环几万次 await 会把登录页卡死。
 * 这是「摩擦层」不是密码学证明 —— 专业攻击者可以用原生代码加速，
 * 但它让浏览器里跑的批量脚本每次尝试都要付出一次真实算力成本。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdminPow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function hash32(seed, nonce) {
    var s = String(seed) + ':' + String(nonce);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  function solve(seed, difficulty, maxIter) {
    var bits = Number(difficulty) || 0;
    var max = Number(maxIter) || 3000000;
    for (var n = 0; n < max; n += 1) {
      if (Math.clz32(hash32(seed, n)) >= bits) return String(n);
    }
    return '';
  }

  function verify(seed, nonce, difficulty) {
    if (nonce === '' || nonce === null || nonce === undefined) return false;
    var n = Number(nonce);
    var bits = Number(difficulty) || 0;
    if (!Number.isInteger(n) || n < 0 || n > 3000000) return false;
    if (bits < 0 || bits > 24) return false;
    return Math.clz32(hash32(seed, n)) >= bits;
  }

  return { hash32: hash32, solve: solve, verify: verify, DIFFICULTY: 16 };
});
