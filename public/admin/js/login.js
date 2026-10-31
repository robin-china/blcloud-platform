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
      <button class="btn primary" style="width:100%;justify-content:center;margin-top:6px" :disabled="loading" @click="submit">
        {{ loading ? '登录中...' : '登录' }}
      </button>
      <div class="hint" style="text-align:center;margin-top:14px">首次部署的初始密码见 data/admin-init-password.txt</div>
    </div>

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
          <button class="btn" @click="skipPwd">稍后提醒</button>
          <button class="btn primary" :disabled="pwdLoading" @click="changePwd">{{ pwdLoading ? '提交中...' : '确认修改' }}</button>
        </div>
      </div>
    </div>
  </div>
  `,
  props: { settings: { type: Object, default: () => ({}) } },
  emits: ['logged'],
  setup(props, { emit }) {
    const form = Vue.reactive({ username: 'admin', password: '' });
    const loading = Vue.ref(false);
    const forcePwd = Vue.ref(false);
    const pwdLoading = Vue.ref(false);
    const pwd = Vue.reactive({ old: '', next: '', confirm: '' });

    function done(res) {
      U.api.setToken('admin', res.token);
      emit('logged', res.token);
    }

    async function submit() {
      if (loading.value) return;
      loading.value = true;
      try {
        const res = await U.api.post('/api/admin/login', form);
        U.api.setToken('admin', res.token);
        if (res.must_change_password) {
          pwd.old = form.password;
          forcePwd.value = true;
          U.toast('请先修改初始密码', 'warning');
          return;
        }
        done(res);
        U.toast('登录成功', 'success');
      } catch (e) {
        U.toast(e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

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
        await U.api.post('/api/admin/password', { oldPassword: pwd.old, newPassword: pwd.next });
        forcePwd.value = false;
        U.toast('密码已更新', 'success');
        done({ token: U.api.getToken('admin') });
      } catch (e) {
        U.toast(e.message, 'error');
      } finally {
        pwdLoading.value = false;
      }
    }

    return { form, loading, submit, forcePwd, pwd, pwdLoading, changePwd, skipPwd };
  },
};
})();
