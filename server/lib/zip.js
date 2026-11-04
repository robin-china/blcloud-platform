/* 最小 ZIP 读写（无第三方依赖）
 *
 * 为什么自己写：账套备份要打成「一个文件」才能下载、上传、拷走，
 * 项目里没有 archiver 这类依赖，为一个功能引一棵依赖树不值当。
 * 只用 ZIP 的存储(stored)方式写入 —— 数据库文件本身已是压缩过的结构，
 * 再 deflate 收益很小；读取时同时支持 stored 与 deflate，
 * 这样别人用系统自带工具重新打的包也能解开。
 *
 * 约束：
 *  - 不写 ZIP64（单文件 > 4GB 不支持，账套远达不到）
 *  - 写入文件名统一 UTF-8（flag bit 11）
 *  - 读取时拒绝路径穿越（../ 或绝对路径），防止恶意包写到目录外
 */
const zlib = require('zlib');

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function dosDateTime(d) {
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  return { date, time };
}

function safeName(name) {
  const n = String(name || '').replace(/\\/g, '/');
  if (!n) throw new Error('zip: 条目名为空');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) {
    throw new Error(`zip: 非法条目名 ${n}`);
  }
  return n;
}

/**
 * entries: [{ name, data: Buffer|string, date?: Date }]
 * 返回完整 zip Buffer
 */
function createZip(entries) {
  const now = new Date();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = safeName(e.name);
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(data);
    const { date, time } = dosDateTime(e.date instanceof Date ? e.date : now);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
    local.writeUInt16LE(0, 8);           // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);        // stored
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);   // local header offset

    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

/**
 * 解析 zip，返回 Map<name, Buffer>
 * 支持 stored(0) 与 deflate(8)
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('zip: 不是有效的压缩包');
  // EOCD 在文件末尾，注释最长 65535
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: 找不到目录结尾（文件可能损坏）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > 5000) throw new Error('zip: 条目过多，拒绝解析');
  if (cdOffset + cdSize > buf.length) throw new Error('zip: 目录越界（文件可能损坏）');

  const out = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('zip: 中央目录损坏');
    }
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('zip: 本地头损坏');
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    if (start + csize > buf.length) throw new Error('zip: 数据越界');
    const raw = buf.slice(start, start + csize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`zip: 不支持的压缩方式 ${method}`);

    if (usize && data.length !== usize) throw new Error('zip: 解压长度不符');
    out.set(safeName(name), data);
  }
  return out;
}

module.exports = { createZip, readZip, crc32 };
