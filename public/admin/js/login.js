(function () {
window.PageLogin = {
  template: `
  <div class="login-page">
    <div class="login-card">
      <div class="logo">
        <div v-if="settings.site_logo" style="width:40px;height:40px;border-radius:10px;overflow:hidden">
          <img :src="settings.site_logo" style="width:100%;height:100%;object-fit:contain" />
        </div>
        <div v-else style="width:40px;height:40px;border-radius:10px;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:700">
          {{ (settings.site_short_name || 'M').slice(0, 1) }}
        </div>
        <div style="text-align:left">
          <div style="font-weight:600;font-size:15px">{{ settings.site_name || '管理后台' }}</div>
          <div style="color:var(--text-3);font-size:12px">管理员登录</div>
        </div>
      </div>
      <h2>欢迎回来</h2>
      <div class="tip">请使用管理员账号登录后台</div>
      <div class="field">
        <label>账号</label>
        <input class="input" v-model="form.username" placeholder="admin" @keyup.enter="submit" />
      </div>
      <div class="field">
        <label>密码</label>
        <input class="input" type="password" v-model="form.password" placeholder="请输入密码" @keyup.enter="submit" />
      </div>
      <div class="field" v-if="captcha.required">
        <label>图形验证</label>
        <div style="display:flex;gap:8px;align-items:center">
          <div style="flex:none;cursor:pointer;border-radius:6px;overflow:hidden;line-height:0" title="点击刷新" v-html="captcha.svg" @click="refreshCaptcha"></div>
          <input class="input" v-model="form.answer" inputmode="numeric" maxlength="4" placeholder="图中 4 位数字" @keyup.enter="submit" />
        </div>
        <div class="hint" style="margin-top:5px">点击图片可刷新；每次验证仅对本轮登录有效</div>
      </div>
      <button class="btn primary" style="width:100%;justify-content:center;margin-top:6px" :disabled="loading" @click="submit">
        {{ loading ? '登录中...' : '登录' }}
      </button>
      <div class="hint" style="text-align:center;margin-top:14px">首次部署的初始密码见 data/admin-init-password.txt</div>
    </div>

    <teleport to="body">
      <div class="mask" v-if="second.needed">
        <div class="modal" style="max-width:420px">
          <div class="modal-head"><h3>第二因素验证</h3></div>
          <div class="modal-body">
            <div class="hint" style="margin-bottom:12px">该账号已启用动态口令，请输入验证器中的 6 位数字；也可用一次性恢复码。</div>
            <div class="field">
              <label>动态码 / 恢复码</label>
              <input class="input" v-model="second.code" autocomplete="one-time-code" placeholder="000000" @keyup.enter="submitSecond" />
            </div>
            <div v-if="second.error" style="color:var(--danger);font-size:13px;margin-top:8px">{{ second.error }}</div>
          </div>
          <div class="modal-foot">
            <button class="btn" @click="cancelSecond">返回重新登录</button>
            <button class="btn primary" :disabled="second.loading" @click="submitSecond">
              {{ second.loading ? '验证中...' : '确认' }}
            </button>
          </div>
        </div>
      </div>
    </teleport>

    <div class="mask" v-if="forcePwd" @click.self="">
      <div class="modal" style="max-width:420px">
        <div class="modal-head"><h3>需要修改密码</h3></div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:12px">当前密码为初始密码或弱口令，请先修改为至少 8 位的新密码。</div>
          <div class="field"><label>当前密码</label><input class="input" type="password" v-model="pwd.old" /></div>
          <div class="field"><label>新密码（至少 8 位）</label><input class="input" type="password" v-model="pwd.next" /></div>
          <div class="field"><label>确认新密码</label><input class="input" type="password" v-model="pwd.confirm" @keyup.enter="changePwd" /></div>
        </div>
        <div class="modal-foot">
          <!-- 生产环境后端会把受限令牌拦成 403（所有管理接口只放行改密），
               跳过没有意义；本地/测试不拦，可以稍后处理 -->
          <button v-if="!mcpEnforced" class="btn" @click="skipPwd">稍后提醒</button>
          <button class="btn primary" :disabled="pwdLoading" @click="changePwd">
            {{ pwdLoading ? '提交中...' : (mcpEnforced ? '确认修改并进入后台' : '确认修改') }}
          </button>
        </div>
      </div>
    </div>
  </div>
  `,
  props: { settings: { type: Object, default: () => ({}) } },
  emits: ['logged'],
  setup(props, { emit }) {
    const form = Vue.reactive({ username: 'admin', password: '', answer: '', challengeId: '', powNonce: '' });
    const loading = Vue.ref(false);
    const forcePwd = Vue.ref(false);
    const pwdLoading = Vue.ref(false);
    const mcpEnforced = Vue.ref(false);
    const pwd = Vue.reactive({ old: '', next: '', confirm: '' });
    const captcha = Vue.reactive({ required: false, svg: '', powSeed: '', difficulty: 16 });
    const second = Vue.reactive({ needed: false, challengeToken: '', code: '', error: '', loading: false });

    function done(res) {
      U.api.setToken('admin', res.token);
      emit('logged', res.token);
    }

    /** PoW 是同步循环，让出一帧再算，避免卡住首屏渲染；提交时还有一次兜底。 */
    function solvePow() {
      const P = window.AdminPow;
      if (!P || !captcha.powSeed) { form.powNonce = ''; return; }
      Vue.nextTick(() => { form.powNonce = P.solve(captcha.powSeed, captcha.difficulty); });
    }

    async function loadChallenge(force) {
      try {
        const q = force ? '?force=1' : '';
        const c = await U.api.get('/api/admin/challenge' + q);
        if (!c.required) {
          captcha.required = false; captcha.svg = ''; captcha.powSeed = '';
          form.challengeId = ''; form.powNonce = '';
          return;
        }
        captcha.required = true;
        captcha.svg = c.svg || '';
        captcha.powSeed = c.powSeed || '';
        captcha.difficulty = Number(c.difficulty) || 16;
        form.challengeId = c.challengeId || '';
        form.answer = '';
        form.powNonce = '';
        solvePow();
      } catch (e) { /* 取不到就先不显示；提交时服务端会明确要求 */ }
    }

    function refreshCaptcha() { loadChallenge(true); }

    async function submit() {
      if (loading.value) return;
      loading.value = true;
      try {
        if (captcha.required && form.challengeId && !form.powNonce && window.AdminPow) {
          form.powNonce = window.AdminPow.solve(captcha.powSeed, captcha.difficulty);
        }
        const payload = { username: form.username, password: form.password };
        if (captcha.required && form.challengeId) {
          payload.challengeId = form.challengeId;
          payload.answer = form.answer;
          payload.powNonce = form.powNonce;
        }
        const res = await U.api.post('/api/admin/login', payload);
        if (res.needSecondFactor) {
          second.needed = true;
          second.challengeToken = res.challengeToken;
          second.code = '';
          second.error = '';
          U.toast('请输入验证器动态码', 'warning');
          return;
        }
        U.api.setToken('admin', res.token);
        if (res.must_change_password) {
          pwd.old = form.password;
          mcpEnforced.value = !!res.mcp_enforced;
          forcePwd.value = true;
          U.toast('请先修改初始密码', 'warning');
          return;
        }
        if (res.two_fa_suggested) U.toast('建议到「管理员 → 登录安全」启用动态口令', 'warning');
        done(res);
        U.toast('登录成功', 'success');
      } catch (e) {
        const d = e.data || {};
        U.toast(e.message, 'error');
        if (d.captchaRequired || captcha.required) await loadChallenge(true);
      } finally {
        loading.value = false;
      }
    }

    function cancelSecond() {
      second.needed = false;
      second.code = '';
      second.error = '';
      if (captcha.required) loadChallenge(true);
    }

    async function submitSecond() {
      if (second.loading || !String(second.code || '').trim()) return;
      second.loading = true;
      second.error = '';
      try {
        const res = await U.api.post('/api/admin/login/2fa', {
          challengeToken: second.challengeToken, code: String(second.code).trim(),
        });
        second.needed = false;
        done(res);
        U.toast('登录成功', 'success');
      } catch (e) {
        second.error = e.message;
        const d = e.data || {};
        if (d.code === 'CHALLENGE_INVALID' || d.code === 'CHALLENGE_USED'
          || d.code === 'CHALLENGE_EXPIRED' || d.code === 'CHALLENGE_IP_MISMATCH') {
          second.needed = false;
          U.toast('验证票据已失效，请重新登录', 'warning');
          if (captcha.required) loadChallenge(true);
        }
      } finally {
        second.loading = false;
      }
    }

    Vue.watch(() => second.needed, function (v) {
      document.body.style.overflow = v ? 'hidden' : '';
    });
    function onKey(e) { if (e.key === 'Escape' && second.needed) cancelSecond(); }
    window.addEventListener('keydown', onKey);

    function skipPwd() {
      forcePwd.value = false;
      done({ token: U.api.getToken('admin') });
      U.toast('登录成功，请尽快在「管理员」中修改密码', 'warning');
    }

    async function changePwd() {
      if (pwdLoading.value) return;
      if (String(pwd.next || '').length < 8) return U.toast('新密码至少 8 位', 'error');
      if (pwd.next !== pwd.confirm) return U.toast('两次输入的新密码不一致', 'error');
      pwdLoading.value = true;
      try {
        // 改密成功后服务端会重新签发完整令牌（旧的是受限令牌，只能调这一个接口）
        const res = await U.api.post('/api/admin/password', { oldPassword: pwd.old, newPassword: pwd.next });
        forcePwd.value = false;
        U.toast('密码已更新', 'success');
        done(res.token ? res : { token: U.api.getToken('admin') });
      } catch (e) {
        U.toast(e.message, 'error');
      } finally {
        pwdLoading.value = false;
      }
    }

    Vue.onMounted(function () { loadChallenge(false); });

    return {
      form, loading, submit, forcePwd, pwd, pwdLoading, changePwd, skipPwd, mcpEnforced,
      captcha, refreshCaptcha, second, submitSecond, cancelSecond,
    };
  },
};
})();
