const db = require('../db');
const { now, safeJson, genLicenseKey } = require('../lib/util');
const plans = require('../lib/plans');
const tb = require('./tb');
const blcloud = require('../lib/blcloud');

/**
 * 支付成功后自动发放授权与硬件。
 * 单独成模块：services/pay.js 与 routes/orders.js 都要用它，
 * 放在任一处都会形成循环依赖（require 拿到未初始化完的 exports）。
 */
/**
 * 额度包商品该发多少次。
 * 优先用后台显式填写的「API 额度」字段；没填才回退到从名称/副标题/描述里
 * 认「10 万次」「10万」「100000 次」这类写法；都认不出才用默认值。
 * 之前只看 description，而种子商品的「10 万次」写在 subtitle 里 —— 直接漏配。
 */
function resolveQuota(product) {
  const explicit = Number(product.quota || 0);
  if (explicit > 0) return explicit;
  const text = [product.name, product.subtitle, product.description].filter(Boolean).join(' ');
  const wan = text.match(/(\d+(?:\.\d+)?)\s*万\s*次?/);
  if (wan) return Math.round(Number(wan[1]) * 10000);
  const plain = text.match(/(\d+)\s*次/);
  if (plain) return Number(plain[1]);
  return 100000;
}

/**
 * 套餐新购：发一张绑定档位的授权码。
 * product_id = 0 表示「套餐授权，不绑定具体商品」（schema 里该列 NOT NULL）。
 */
function deliverPlanPurchase(order) {
  const plan = plans.get(order.plan_id);
  if (!plan) throw new Error(`套餐档位 ${order.plan_id} 不存在，无法发货`);
  const ts = now();
  const key = genLicenseKey();
  const endAt = plan.billing === 'period' ? plans.addDays(plan.period_days) : null;
  const licType = plan.billing === 'period' ? 'subscription' : 'permanent';
  // 套餐授权必须落到具体软件产品上，否则 A 产品的码能在 B 产品里激活
  const appId = Number(plan.app_id) || Number(order.app_id) || null;
  const info = db.prepare(`INSERT INTO licenses
    (license_key, user_id, app_id, product_id, type, max_devices, start_at, end_at, status,
     plan_id, plan_code, order_id, remark, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(key, order.user_id, appId, 0, licType, Number(plan.max_devices) || 1,
      ts, endAt, 'active', plan.id, plan.code, order.id, `订单自动发放：${plan.name}`, ts);
  return {
    type: 'license', license_key: key, product: plan.name,
    license_id: info.lastInsertRowid, plan_code: plan.code,
    end_at: endAt,
  };
}

/**
 * 取订单指向的授权，必须属于下单人。
 * 这一步不能省：否则别人拿自己的订单号 + 任意 license_id 就能改别人的授权。
 */
function ownedLicense(order) {
  const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(order.ref_license_id) || 0);
  if (!lic) throw new Error('待升级/续费的授权不存在');
  if (Number(lic.user_id) !== Number(order.user_id)) throw new Error('授权与订单用户不一致');
  if (lic.status === 'revoked') throw new Error('授权已吊销，无法升级或续费');
  return lic;
}

/**
 * 续费：只延长同一张授权的 end_at，绝不发新码。
 * licenseState / verify / heartbeat / ticket 全绑在 license_id + machine_id 上，
 * 发新码会让老设备立刻被判 MACHINE_NOT_BOUND，用户续一次费就得重新激活。
 */
function deliverRenew(order) {
  const lic = ownedLicense(order);
  const plan = plans.get(order.plan_id) || plans.licensePlan(lic);
  if (!plan) throw new Error('找不到续费对应的档位');
  const days = plan.billing === 'period' ? (Number(plan.period_days) || 365) : 365;
  const base = lic.end_at ? Math.max(Date.parse(lic.end_at), Date.now()) : Date.now();
  const endAt = new Date(base + days * 86400000).toISOString();
  // 过期降级的痕迹必须一起清掉：留着 downgraded_from，客户端续费后仍会提示
  // 「订阅到期已降级」，而且 entitlementVersion 把它算进哈希，版本号也对不上。
  db.prepare(`UPDATE licenses SET end_at = ?, plan_id = ?, plan_code = ?, status = 'active',
    downgraded_from = '', downgraded_at = '' WHERE id = ?`)
    .run(endAt, plan.id, plan.code, lic.id);
  return {
    type: 'license_renew', license_key: lic.license_key, license_id: lic.id,
    product: plan.name, plan_code: plan.code, days, end_at: endAt,
  };
}

/** 升级：原地改档位/设备数，保留 license_key 与所有已绑定机器。 */
function deliverUpgrade(order) {
  const lic = ownedLicense(order);
  const plan = plans.get(order.plan_id);
  if (!plan) throw new Error('找不到升级目标档位');
  const cur = plans.licensePlan(lic);
  if (cur && Number(plan.tier) <= Number(cur.tier)) {
    throw new Error('只能升级到更高档位');
  }
  let endAt = lic.end_at;
  if (plan.billing === 'period' && !endAt) endAt = plans.addDays(plan.period_days || 365);
  if (plan.billing !== 'period') endAt = null;
  const planAppId = Number(plan.app_id) || 0;

  // 注册时发的「不限应用」通用码（app_id 为空）：直接升级会把这张码固化到本次下单的产品，
  // 用户在别的软件里用它就会「突然失效」，看起来像 bug。
  // 改为发放一张该产品专属的新授权（机器绑定复制过去、免重新激活），通用码保持原样继续通用。
  if (planAppId && !Number(lic.app_id)) {
    const ts = now();
    const key = genLicenseKey();
    const info = db.prepare(`INSERT INTO licenses
      (license_key, user_id, app_id, product_id, type, max_devices, start_at, end_at, status,
       plan_id, plan_code, order_id, remark, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(key, lic.user_id, planAppId, 0, plan.billing === 'period' ? 'subscription' : 'permanent',
        Number(plan.max_devices) || 1, ts, endAt, 'active', plan.id, plan.code, order.id,
        `通用授权升级转产品授权（原码 ${lic.license_key}）`, ts);
    // 复制机器绑定：升级后老设备不用重新激活（会话仍指旧码也不受影响）
    db.prepare(`INSERT INTO license_devices
      (license_id, device_sn, device_name, machine_id, app_id, last_ip, last_version, last_seen_at, bound_at)
      SELECT ?, device_sn, device_name, machine_id, ?, last_ip, last_version, last_seen_at, bound_at
      FROM license_devices WHERE license_id = ?`)
      .run(info.lastInsertRowid, planAppId, lic.id);
    return {
      type: 'license_upgrade', license_key: key, license_id: Number(info.lastInsertRowid),
      product: plan.name, plan_code: plan.code,
      from_plan: cur ? cur.code : '', from_license: lic.license_key,
      max_devices: plan.max_devices, end_at: endAt, new_license: true,
      note: '已转为该产品专属授权码，原通用码保持可用',
    };
  }

  const appId = planAppId || Number(order.app_id) || Number(lic.app_id) || null;
  db.prepare(`UPDATE licenses SET plan_id = ?, plan_code = ?, max_devices = ?, end_at = ?,
    type = ?, status = 'active', app_id = ?, downgraded_from = '', downgraded_at = '' WHERE id = ?`)
    .run(plan.id, plan.code, Number(plan.max_devices) || 1, endAt,
      plan.billing === 'period' ? 'subscription' : 'permanent', appId, lic.id);
  return {
    type: 'license_upgrade', license_key: lic.license_key, license_id: lic.id,
    product: plan.name, plan_code: plan.code,
    from_plan: cur ? cur.code : '', max_devices: plan.max_devices, end_at: endAt,
  };
}

/** 支付成功后自动发放授权与硬件 */
function deliverOrder(order) {
  const kind = String(order.kind || 'purchase');
  if (kind === 'renew') return [deliverRenew(order)];
  if (kind === 'upgrade') return [deliverUpgrade(order)];
  if (order.plan_id) return [deliverPlanPurchase(order)];

  const items = safeJson(order.items, []);
  const created = [];
  for (const it of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(it.product_id));
    if (!product) continue;
    if (product.type === 'service') {
      const quota = resolveQuota(product);
      // 关键：用户端真正扣减的额度池是 users.blcloud_quota（blcloud 开放平台），
      // 不是 api_keys 表。以前充到 api_keys，用户付了钱但页面额度纹丝不动。
      const before = db.prepare('SELECT blcloud_quota, blcloud_used FROM users WHERE id = ?').get(order.user_id);
      const q = blcloud.addQuota(order.user_id, quota,
        `订单 ${order.order_no} 购买「${product.name}」发放 API 额度 ${quota} 次`);
      created.push({
        type: 'api_quota',
        quota,
        product: product.name,
        before: Number(before?.blcloud_quota || 0),
        after: Number(q.total || 0),
        remaining: Number(q.remaining || 0),
      });
      continue;
    }
    // 与后台手工发放共用同一个生成器：格式必须一致，
    // 否则文档示例、客服核对、客户端校验兜底用的正则各说各话
    const licenseKey = genLicenseKey();
    const info = db.prepare(`INSERT INTO licenses (license_key, user_id, product_id, type, max_devices, start_at, end_at, status, order_id, remark, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(licenseKey, order.user_id, product.id, product.type === 'software' ? 'permanent' : 'subscription',
        Number(it.qty) || 1, now(), product.type === 'software' ? null : plans.addDays(365), 'active', order.id, '订单自动发放', now());
    db.prepare('UPDATE products SET total_sales = total_sales + ? WHERE id = ?').run(Number(it.qty) || 1, product.id);
    created.push({ type: 'license', license_key: licenseKey, product: product.name, license_id: info.lastInsertRowid });

    if (product.type === 'hardware') {
      const qty = Number(it.qty) || 1;
      for (let i = 0; i < qty; i++) {
        const sn = `HW${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        const dev = db.prepare(`INSERT INTO devices (user_id, product_id, sn, name, model, status, bound_at)
          VALUES (?,?,?,?,?, 'online', ?)`)
          .run(order.user_id, product.id, sn, product.name, product.version || '', now());
        tb.createDevice({ name: sn, type: product.category || 'default' })
          .then((d) => {
            if (d.deviceId) {
              db.prepare('UPDATE devices SET tb_device_id = ?, tb_token = ? WHERE id = ?')
                .run(d.deviceId, d.token || '', dev.lastInsertRowid);
            }
          })
          .catch(() => {});
        created.push({ type: 'device', sn, product: product.name });
      }
    }
  }
  return created;
}

module.exports = { deliverOrder };
