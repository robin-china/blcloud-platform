(function () {
const { ref, reactive, onMounted, computed } = Vue;

window.PageSettings = {
  template: `
  <div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>站点信息</h3></div>
      <div class="card-body">
        <div class="field-row">
          <div class="field"><label>站点名称</label><input class="input" v-model="s.site_name" /></div>
          <div class="field"><label>简称（侧边栏）</label><input class="input" v-model="s.site_short_name" /></div>
        </div>
        <div class="field"><label>站点简介</label><input class="input" v-model="s.site_description" /></div>
        <div class="field-row">
          <div class="field"><label>备案号</label><input class="input" v-model="s.site_icp" placeholder="京ICP备xxxxxxxx号" /></div>
          <div class="field"><label>联系方式</label><input class="input" v-model="s.site_contact" placeholder="邮箱 / 电话" /></div>
        </div>
        <div class="field"><label>版权信息</label><input class="input" v-model="s.site_copyright" /></div>
        <button class="btn primary" @click="save">保存站点信息</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Logo 与主题</h3></div>
      <div class="card-body">
        <div class="field"><label>站点 Logo</label>
          <div style="display:flex;gap:12px;align-items:center">
            <div style="width:64px;height:64px;border-radius:10px;border:1px solid var(--border);display:grid;place-items:center;overflow:hidden">
              <img v-if="s.site_logo" :src="s.site_logo" style="width:100%;height:100%;object-fit:contain" />
              <span v-else style="color:var(--text-3);font-size:12px">未设置</span>
            </div>
            <input type="file" accept="image/*" @change="upload('site_logo', $event)" />
          </div>
        </div>
        <div class="field"><label>Favicon</label>
          <div style="display:flex;gap:12px;align-items:center">
            <div style="width:32px;height:32px;border-radius:8px;border:1px solid var(--border);display:grid;place-items:center;overflow:hidden">
              <img v-if="s.site_favicon" :src="s.site_favicon" style="width:100%;height:100%;object-fit:contain" />
              <span v-else style="color:var(--text-3);font-size:12px">未设置</span>
            </div>
            <input type="file" accept="image/*" @change="upload('site_favicon', $event)" />
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label>主题色</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="color" v-model="s.theme_color" style="width:46px;height:34px;border:1px solid var(--border);border-radius:6px" />
              <input class="input" v-model="s.theme_color" />
            </div>
          </div>
          <div class="field"><label>界面模式</label>
            <select class="select" v-model="s.theme_mode"><option value="light">浅色</option><option value="dark">深色（二期）</option></select>
          </div>
        </div>
        <button class="btn primary" @click="save">保存外观</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>用户与支付规则</h3></div>
      <div class="card-body">
        <div class="field"><label>每日签到赠送积分</label><input class="input" type="number" v-model.number="s.user_points_signin" /></div>
        <div class="field">
          <label class="switch" style="margin-bottom:8px">
            <input type="checkbox" :checked="s.pay_simulate==='1'" @change="s.pay_simulate = $event.target.checked ? '1' : '0'" />
            <span class="track"></span><span>开启模拟支付（未配置商户时用于联调）</span>
          </label>
          <div class="hint">开启后，用户下单可直接「模拟支付完成」；配置好微信支付 / 支付宝后建议关闭。</div>
        </div>
        <div class="field"><label>演示模式（模拟扫码登录 / 验证码回显）</label>
          <select class="select" v-model="s.dev_simulate">
            <option value="">跟随运行环境（NODE_ENV 非 production 时开启）</option>
            <option value="1">强制开启（本地联调）</option>
            <option value="0">强制关闭（生产环境建议）</option>
          </select>
          <div class="hint">演示模式允许用任意 OpenID 直接登录、并在短信接口回显验证码。一旦在接入配置里填好微信服务号 AppID/Secret，模拟扫码会被强制停用。</div>
        </div>
        <button class="btn primary" @click="save">保存规则</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>预览</h3></div>
      <div class="card-body">
        <div style="display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--border);border-radius:12px">
          <div style="width:44px;height:44px;border-radius:10px;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:600;overflow:hidden">
            <img v-if="s.site_logo" :src="s.site_logo" style="width:100%;height:100%;object-fit:contain" />
            <span v-else>{{ (s.site_short_name||'站').slice(0,1) }}</span>
          </div>
          <div>
            <div style="font-weight:600;font-size:15px">{{ s.site_name || '站点名称' }}</div>
            <div style="color:var(--text-3);font-size:12px">{{ s.site_description || '站点简介' }}</div>
          </div>
        </div>
        <div style="color:var(--text-3);font-size:12.5px;margin-top:12px">
          {{ s.site_copyright }}<br />{{ s.site_icp }} {{ s.site_contact }}
        </div>
        <div style="margin-top:14px"><a class="btn" href="/user/" target="_blank">打开用户端预览</a></div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const s = reactive({});
    async function load() {
      const res = await U.api.get('/api/settings');
      Object.assign(s, res.settings);
    }
    async function save() {
      await U.api.post('/api/settings', s);
      U.applySiteSettings(s);
      U.toast('已保存', 'success');
    }
    async function upload(key, e) {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${U.basePath}/api/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${U.api.getToken('admin')}` }, body: fd,
      }).then((r) => r.json());
      if (res.url) s[key] = res.url;
    }
    onMounted(load);
    return { s, save, upload };
  },
};

const TABS = [
  { key: 'wechat', name: '微信服务号' },
  { key: 'wxpay', name: '微信支付' },
  { key: 'alipay', name: '支付宝' },
  { key: 'tb', name: 'blcloud 物联' },
  { key: 'sms', name: '短信' },
];

window.PageIntegration = {
  template: `
  <div>
    <div class="tabs">
      <button v-for="t in tabs" :key="t.key" :class="tab===t.key?'active':''" @click="tab=t.key">{{ t.name }}</button>
    </div>

    <div class="card" v-if="tab==='wechat'">
      <div class="card-head"><h3>微信服务号</h3>
        <label class="switch"><input type="checkbox" v-model="c.enable" /><span class="track"></span><span>启用</span></label>
      </div>
      <div class="card-body">
        <div class="field-row">
          <div class="field"><label>AppID</label><input class="input" v-model="c.appid" /></div>
          <div class="field"><label>AppSecret</label><input class="input" v-model="c.appsecret" placeholder="留空表示不修改" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>消息校验 Token</label><input class="input" v-model="c.token" /></div>
          <div class="field"><label>消息加密密钥</label><input class="input" v-model="c.aes_key" /></div>
        </div>
        <div class="hint">服务器地址（URL）填写：<b>{{ origin }}/api/wechat/server</b>，消息加密方式可选明文或安全模式，系统均已兼容。</div>
        <div class="field-row" style="margin-top:14px">
          <div class="field">
            <label>微信内免扫码登录（网页授权范围）</label>
            <select class="select" v-model="c.oauth_scope">
              <option value="snsapi_base">静默授权：不弹窗，直接登录（推荐）</option>
              <option value="snsapi_userinfo">需要昵称头像：首次弹一次「允许」</option>
            </select>
            <div class="hint">
              微信内置浏览器打开用户中心时自动登录，不再要求扫码。
              需到公众号后台「设置与开发 → 公众号设置 → 功能设置 → <b>网页授权域名</b>」填
              <b>{{ wxDomain }}</b>（只填域名，不带路径和 /platform）；未配置时微信会报 redirect_uri 参数错误。
            </div>
          </div>
          <div class="field">
            <label>网页授权回调地址（自动生成，供核对）</label>
            <input class="input" :value="origin + '/api/wechat/oauth/callback'" readonly />
            <div class="hint">静默授权拿不到昵称，已关注用户仍会补齐微信昵称/头像；未关注则显示「用户XXXX」，可在账户中心自行修改。</div>
          </div>
        </div>
        <div class="btn-group" style="margin-top:14px">
          <button class="btn primary" @click="save('wechat')">保存</button>
          <button class="btn" @click="testWechat">测试连接</button>
          <button class="btn" @click="diagWechat">回调诊断</button>
        </div>
        <div v-if="diag" style="margin-top:14px">
          <div class="hint" style="margin-bottom:8px">「回调诊断」看的是<b>微信真实打到本机的推送记录</b>：扫完码没反应时，先看有没有「收到微信推送」这条。</div>
          <div v-if="diag.problems.length" style="border:1px solid var(--danger);border-radius:8px;padding:10px 12px;margin-bottom:10px">
            <div style="font-weight:600;color:var(--danger);margin-bottom:6px">配置缺口</div>
            <div v-for="p in diag.problems" :key="p" style="font-size:13px;line-height:1.7">• {{ p }}</div>
          </div>
          <div v-else style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:13px">
            四项配置（AppID / AppSecret / Token / EncodingAESKey）均已填写且已启用
          </div>
          <table class="table" v-if="diag.events.length">
            <thead><tr><th style="width:150px">时间</th><th style="width:90px">类型</th><th>详情</th></tr></thead>
            <tbody>
              <tr v-for="(e,i) in diag.events" :key="i">
                <td style="font-size:12px;color:var(--text-3)">{{ fmtTime(e.ts) }}</td>
                <td><span :class="'tag ' + (e.level==='error'?'danger':e.level==='ok'?'success':'')">{{ e.type }}</span></td>
                <td style="font-size:13px" :style="e.level==='error'?'color:var(--danger)':''">{{ e.detail }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="hint">还没有收到过任何微信推送。若已经扫过码，说明微信的请求没到本机：检查公众号后台「服务器配置」是否已启用，且 URL 就是这个地址 —— <b>{{ diag.server_url }}</b></div>
        </div>
      </div>
    </div>

    <div class="card" v-if="tab==='wxpay'">
      <div class="card-head"><h3>微信支付 v3</h3>
        <label class="switch"><input type="checkbox" v-model="c.enable" /><span class="track"></span><span>启用</span></label>
      </div>
      <div class="card-body">
        <div class="field-row">
          <div class="field"><label>商户号 MCHID</label><input class="input" v-model="c.mchid" /></div>
          <div class="field"><label>应用 AppID</label><input class="input" v-model="c.appid" /></div>
        </div>
        <div class="field"><label>API v3 密钥</label><input class="input" v-model="c.api_v3_key" placeholder="留空表示不修改" /></div>
        <div class="field"><label>商户 API 证书序列号</label><input class="input" v-model="c.mch_cert_serial" /></div>
        <div class="field"><label>商户私钥（apiclient_key.pem 内容）</label><textarea class="input" v-model="c.private_key" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></div>
        <div class="field-row">
          <div class="field"><label>微信支付公钥ID</label><input class="input" v-model="c.pub_key_id" placeholder="PUB_KEY_ID_xxxxxxxxxxxx" /></div>
          <div class="field"><label>验签模式</label><input class="input" :value="verifyModeText" disabled /></div>
        </div>
        <div class="field"><label>微信支付公钥内容</label><textarea class="input" v-model="c.pub_key" placeholder="-----BEGIN PUBLIC KEY-----"></textarea></div>
        <div class="hint">2024 年起新商户号<b>已无法下载平台证书</b>：回调会报「无可用的平台证书 / RESOURCE_NOT_EXISTS」。
          此时请到 商户平台 → 账户中心 → API安全 → 申请「微信支付公钥」，把<b>公钥ID</b>与<b>公钥内容</b>填到这里保存，
          回调即可<b>本地验签</b>（不再联网拉证书）。</div>
        <div class="field"><label>回调地址</label><input class="input" v-model="c.notify_url" :placeholder="origin + '/api/pay/notify/wxpay'" /></div>
        <div class="hint">留空则自动使用当前站点地址。支付回调路径：<b>{{ origin }}/api/pay/notify/wxpay</b></div>
        <div class="hint">测试连接无需真实付款：会用商户私钥向微信发一次查询请求验证「商户号 + 证书序列号 + 私钥」，
          API v3 密钥则校验长度（平台证书模式下还会实际解密证书，可完整验证）。</div>
        <div class="btn-group" style="margin-top:14px">
          <button class="btn primary" @click="save('wxpay')">保存</button>
          <button class="btn" @click="testWxpay">测试连接</button>
          <button class="btn" @click="diagPay">支付诊断</button>
        </div>
        <div v-if="payDiag" style="margin-top:14px">
          <div v-if="payDiag.problems.length" style="border:1px solid var(--danger);border-radius:8px;padding:10px 12px;margin-bottom:10px">
            <div style="font-weight:600;color:var(--danger);margin-bottom:6px">配置问题</div>
            <div v-for="p in payDiag.problems" :key="p" style="font-size:13px;line-height:1.7">• {{ p }}</div>
          </div>
          <div v-else style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:13px">
            配置已填写完整且已启用｜验签模式：{{ payDiag.mode==='pubkey'?'微信支付公钥':payDiag.mode==='cert'?'手动平台证书':'自动下载平台证书' }}<span v-if="payDiag.pub_key_id">（公钥ID {{ payDiag.pub_key_id }}）</span>
          </div>
          <table class="table" v-if="payDiag.events.length">
            <thead><tr><th style="width:150px">时间</th><th style="width:90px">类型</th><th>详情</th></tr></thead>
            <tbody>
              <tr v-for="(e,i) in payDiag.events" :key="i">
                <td style="font-size:12px;color:var(--text-3)">{{ fmtTime(e.ts) }}</td>
                <td><span :class="'tag ' + (e.level==='error'?'danger':e.level==='ok'?'success':'')">{{ e.type }}</span></td>
                <td style="font-size:13px" :style="e.level==='error'?'color:var(--danger)':''">{{ e.detail }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="hint">还没有任何支付记录。「不出码」时先在这儿看一下 —— 下单失败的原因会写在这里，
            包括微信返回的错误码和对应的处理办法；一条记录都没有，说明请求没到支付这一步。</div>
        </div>
      </div>
    </div>

    <div class="card" v-if="tab==='alipay'">
      <div class="card-head"><h3>支付宝</h3>
        <label class="switch"><input type="checkbox" v-model="c.enable" /><span class="track"></span><span>启用</span></label>
      </div>
      <div class="card-body">
        <div class="field-row">
          <div class="field"><label>应用 AppID</label><input class="input" v-model="c.appid" /></div>
          <div class="field"><label>网关</label>
            <select class="select" v-model="c.gateway">
              <option value="https://openapi.alipay.com/gateway.do">生产环境</option>
              <option value="https://openapi-sandbox.dl.alipaydev.com/gateway.do">沙箱环境</option>
            </select>
          </div>
        </div>
        <div class="field"><label>应用私钥（RSA2）</label><textarea class="input" v-model="c.private_key" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></div>
        <div class="field"><label>支付宝公钥</label><textarea class="input" v-model="c.alipay_public_key"></textarea></div>
        <div class="field"><label>回调地址</label><input class="input" v-model="c.notify_url" :placeholder="origin + '/api/pay/notify/alipay'" /></div>
        <div class="hint">异步通知路径：<b>{{ origin }}/api/pay/notify/alipay</b></div>
        <div class="btn-group" style="margin-top:14px"><button class="btn primary" @click="save('alipay')">保存</button></div>
      </div>
    </div>

    <div class="card" v-if="tab==='tb'">
      <div class="card-head"><h3>blcloud 物联平台（底层 ThingsBoard）</h3>
        <label class="switch"><input type="checkbox" v-model="c.enable" /><span class="track"></span><span>启用</span></label>
      </div>
      <div class="card-body">
        <div class="field"><label>平台地址</label><input class="input" v-model="c.base_url" placeholder="http://localhost:8080" /></div>
        <div class="field-row">
          <div class="field"><label>管理员账号</label><input class="input" v-model="c.username" placeholder="sysadmin@thingsboard.org" /></div>
          <div class="field"><label>管理员密码</label><input class="input" type="password" v-model="c.password" placeholder="留空表示不修改" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>邮箱后缀</label><input class="input" v-model="c.email_suffix" placeholder="@blcloud.cn" /></div>
          <div class="field"><label>默认客户（Customer）</label><input class="input" v-model="c.default_customer" placeholder="default" /></div>
        </div>
        <div class="hint">映射规则：用户 OpenID 为 <b>123abc</b> → blcloud 账户 <b>123abc{{ c.email_suffix }}</b>，密码为 OpenID 本身。用户首次扫码登录时自动开通；用户可在个人中心「blcloud」板块生成 API 密钥调用设备接口（按次计费）。</div>
        <div class="btn-group" style="margin-top:14px">
          <button class="btn primary" @click="save('tb')">保存</button>
          <button class="btn" @click="testTb">测试连接</button>
          <button class="btn" @click="diagTb">开通诊断</button>
        </div>
        <div v-if="tbDiag" style="margin-top:14px">
          <div v-if="tbDiag.problems.length" style="border:1px solid var(--danger);border-radius:8px;padding:10px 12px;margin-bottom:10px">
            <div style="font-weight:600;color:var(--danger);margin-bottom:6px">开通问题</div>
            <div v-for="p in tbDiag.problems" :key="p" style="font-size:13px;line-height:1.7">• {{ p }}</div>
          </div>
          <div v-else style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:13px">
            开关已打开，配置齐全：{{ tbDiag.base_url }}｜邮箱后缀 {{ tbDiag.email_suffix }}
          </div>
          <div style="font-size:13px;margin-bottom:8px">
            账户状态分布：<span v-for="s in tbDiag.by_status" :key="s.s" style="margin-right:10px">{{ tbStatusText(s.s) }} {{ s.c }}</span>
          </div>
          <table class="table" v-if="tbDiag.pending_users.length">
            <thead><tr><th style="width:60px">ID</th><th style="width:160px">blcloud 账户</th><th style="width:90px">状态</th><th>最近一次结果</th></tr></thead>
            <tbody>
              <tr v-for="u in tbDiag.pending_users" :key="u.id">
                <td>{{ u.id }}</td>
                <td style="font-size:12px">{{ u.tb_username || '-' }}</td>
                <td><span class="tag" :class="u.tb_status==='error'?'danger':'warning'">{{ tbStatusText(u.tb_status) }}</span></td>
                <td style="font-size:13px;color:var(--danger)">{{ u.tb_message || '尚无记录' }}</td>
              </tr>
            </tbody>
          </table>
          <table class="table" v-if="tbDiag.events.length">
            <thead><tr><th style="width:150px">时间</th><th>开通步骤</th></tr></thead>
            <tbody>
              <tr v-for="(e,i) in tbDiag.events" :key="i">
                <td style="font-size:12px;color:var(--text-3)">{{ fmtTime(e.ts) }}</td>
                <td style="font-size:13px" :style="e.level==='error'?'color:var(--danger)':''">{{ e.detail }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="hint">还没有任何开通记录。用户一直是「待激活」时先看这里 ——
            若连一条记录都没有，说明开通压根没被触发：检查开关是否打开，以及用户是不是在本开关打开<strong>之前</strong>注册的
            （这种情况到「用户管理 → 详情 → 开通/同步 blcloud 账户」手动补开）。</div>
        </div>
      </div>
    </div>

    <div class="card" v-if="tab==='sms'">
      <div class="card-head"><h3>短信（手机绑定验证码）</h3>
        <label class="switch"><input type="checkbox" v-model="c.enable" /><span class="track"></span><span>启用</span></label>
      </div>
      <div class="card-body">
        <div class="field"><label>服务商</label>
          <select class="select" v-model="c.vendor">
            <option value="simulate">开发模式（验证码直接返回，不下发短信）</option>
            <option value="aliyun">阿里云短信</option>
            <option value="tencent">腾讯云短信</option>
          </select>
        </div>
        <div class="field-row">
          <div class="field"><label>AccessKey / SecretId</label><input class="input" v-model="c.access_key" /></div>
          <div class="field"><label>Secret</label><input class="input" v-model="c.secret" placeholder="留空表示不修改" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>签名</label><input class="input" v-model="c.sign_name" /></div>
          <div class="field"><label>模板 Code</label><input class="input" v-model="c.template_code" /></div>
        </div>
        <div class="btn-group" style="margin-top:14px"><button class="btn primary" @click="save('sms')">保存</button></div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const tabs = TABS;
    const tab = ref('wechat');
    const c = reactive({});
    const raw = reactive({});
    const diag = ref(null);
    const payDiag = ref(null);
    const tbDiag = ref(null);
    // 验签模式决定回调靠什么验签：填了公钥就不再联网拉平台证书
    const verifyModeText = computed(() => (c.pub_key ? '微信支付公钥（本地验签）'
      : c.platform_cert ? '手动平台证书' : '自动下载平台证书'));
    // 带上部署基础路径，子路径部署时提示的回调地址才是对的
    const origin = location.origin + (window.U?.basePath || '');
    // 网页授权域名只能填域名（微信不接受端口与路径），所以单独算一个
    const wxDomain = location.hostname;

    async function load() {
      const res = await U.api.get('/api/settings/integration');
      for (const k of Object.keys(res.config)) raw[k] = res.config[k];
      sync();
    }

    function sync() {
      const cur = raw[tab.value] || {};
      Object.keys(c).forEach((k) => delete c[k]);
      Object.assign(c, cur, { enable: String(cur.enabled) === '1' });
    }

    async function save(name) {
      const payload = { ...c, enabled: c.enable ? 1 : 0 };
      delete payload.enable;
      // 掩码字段未修改则不提交
      for (const [k, v] of Object.entries(payload)) {
        if (typeof v === 'string' && v.includes('****')) delete payload[k];
      }
      await U.api.post(`/api/settings/integration/${name}`, payload);
      U.toast('已保存', 'success');
      load();
    }

    async function testWechat() {
      try {
        const res = await U.api.post('/api/wechat/test', {});
        U.toast(res.message, 'success');
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function diagWechat() {
      try {
        diag.value = await U.api.get('/api/admin/wechat/diag');
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function diagPay() {
      try {
        payDiag.value = await U.api.get('/api/admin/pay/diag');
      } catch (e) { U.toast(e.message, 'error'); }
    }

    function fmtTime(ts) {
      const s = String(ts || '');
      // ISO 里是 UTC，直接取片段显示会差 8 小时，这里转成本地时区
      return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '';
    }

    async function testTb() {
      try {
        const res = await U.api.post('/api/settings/integration/test/tb', {});
        U.toast(res.message || '连接成功', 'success');
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function diagTb() {
      try {
        tbDiag.value = await U.api.get('/api/admin/tb/diag');
      } catch (e) { U.toast(e.message, 'error'); }
    }

    const tbStatusText = (s) => ({ active: '已开通', pending: '待激活', error: '异常', none: '未开通' }[s] || s || '未开通');

    async function testWxpay() {
      try {
        const res = await U.api.post('/api/settings/integration/test/wxpay', {});
        U.toast(res.message || '配置可用', 'success');
      } catch (e) { U.toast(e.message, 'error'); }
    }

    onMounted(load);
    Vue.watch(tab, sync);
    return { tabs, tab, c, origin, wxDomain, save, testWechat, diagWechat, diag, fmtTime, testTb, diagTb, tbDiag, tbStatusText, testWxpay, diagPay, payDiag, verifyModeText };
  },
};

window.PageAdmins = {
  template: `
  <div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>管理员</h3><button class="btn primary sm" @click="openCreate">+ 新增</button></div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>账号</th><th>名称</th><th>角色</th><th>状态</th><th>最近登录</th><th></th></tr></thead>
          <tbody>
            <tr v-for="a in list" :key="a.id">
              <td>{{ a.username }}</td>
              <td>{{ a.name }}</td>
              <td><span class="tag" :class="a.role==='super'?'brand':''">{{ a.role==='super'?'超级管理员':'管理员' }}</span></td>
              <td><span class="tag" :class="a.status==='active'?'success':'danger'">{{ a.status==='active'?'正常':'停用' }}</span></td>
              <td>{{ fmt.ago(a.last_login_at) }}</td>
              <td><button class="btn sm danger" v-if="a.role!=='super'" @click="remove(a)">删除</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>操作日志</h3></div>
      <div class="card-body tight" style="max-height:520px;overflow:auto">
        <table class="table">
          <thead><tr><th>操作人</th><th>动作</th><th>详情</th><th>时间</th></tr></thead>
          <tbody>
            <tr v-for="l in logs" :key="l.id"><td>{{ l.admin_name }}</td><td>{{ l.action }}</td><td>{{ l.detail }}</td><td>{{ fmt.time(l.created_at) }}</td></tr>
            <tr v-if="!logs.length"><td colspan="4"><div class="empty">暂无日志</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="mask" v-if="editing" @click.self="editing=false">
      <div class="modal">
        <div class="modal-head"><h3>新增管理员</h3><button class="close-x" @click="editing=false">&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>登录账号</label><input class="input" v-model="form.username" /></div>
          <div class="field"><label>显示名称</label><input class="input" v-model="form.name" /></div>
          <div class="field"><label>初始密码</label><input class="input" v-model="form.password" /></div>
          <div class="field"><label>角色</label>
            <select class="select" v-model="form.role"><option value="admin">管理员</option><option value="super">超级管理员</option></select>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editing=false">取消</button>
          <button class="btn primary" @click="save">创建</button>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const list = ref([]);
    const logs = ref([]);
    const editing = ref(false);
    const form = reactive({ username: '', name: '', password: '', role: 'admin' });
    const fmt = U.fmt;
    async function load() {
      list.value = (await U.api.get('/api/admin/list')).list;
      logs.value = (await U.api.get('/api/admin/logs?limit=80')).list;
    }
    function openCreate() { Object.assign(form, { username: '', name: '', password: '', role: 'admin' }); editing.value = true; }
    async function save() {
      try {
        await U.api.post('/api/admin/create', form);
        U.toast('已创建', 'success');
        editing.value = false;
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    async function remove(a) {
      if (!(await U.confirm(`删除管理员 ${a.username}？`))) return;
      try {
        await U.api.del(`/api/admin/${a.id}`);
        U.toast('已删除', 'success');
        load();
      } catch (e) { U.toast(U.failMsg(e, '删除失败'), 'error'); }
    }
    onMounted(load);
    return { list, logs, editing, form, fmt, openCreate, save, remove };
  },
};
})();
