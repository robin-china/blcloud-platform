#!/usr/bin/env bash
# 部署 / 更新（在服务器上执行，先体检 → 再问你确认 → 最后才动手）
#   bash deploy/deploy.sh            # 更新代码并重启
#   bash deploy/deploy.sh --init     # 首次安装（建运行用户 + 装依赖 + 注册服务）
#   bash deploy/deploy.sh --check    # 只体检，不改任何东西
#   ASSUME_YES=1 bash deploy/deploy.sh
#
# 破坏性边界：
#   - data/ 永不删除、永不覆盖（数据库、主密钥、上传文件）
#   - 每次更新前先备份数据库，再同步代码
#   - 重启失败会提示看日志，不会静默吞掉
set -uo pipefail

APP_DIR=/opt/blcloud
APP_USER=blcloud
INIT=0; CHECK_ONLY=0
ASSUME_YES=${ASSUME_YES:-0}
TS=$(date +%Y%m%d-%H%M%S)

for a in "$@"; do
  case "$a" in
    --init) INIT=1 ;;
    --check) CHECK_ONLY=1 ;;
    --yes) ASSUME_YES=1 ;;
    *) echo "忽略未知参数: $a" ;;
  esac
done

if [ -t 1 ]; then C0=$'\033[0m'; CC=$'\033[36m'; CG=$'\033[32m'; CY=$'\033[33m'; CR=$'\033[31m'; CB=$'\033[1m';
else C0=""; CC=""; CG=""; CY=""; CR=""; CB=""; fi
h()   { echo -e "\n${CC}${CB}== $* ==${C0}"; }
ok()  { echo -e "  ${CG}✓${C0} $*"; }
warn(){ echo -e "  ${CY}!${C0} $*"; }
bad() { echo -e "  ${CR}✗${C0} $*"; }
info(){ echo -e "    $*"; }
ask() {
  local q="$1" def="${2:-y}" ans
  if [ "$ASSUME_YES" = "1" ]; then echo -e "  ${CY}?${C0} $q  ${def}（自动确认）"; [ "$def" = "y" ]; return; fi
  if [ ! -t 0 ]; then echo -e "  ${CY}?${C0} $q  无交互终端，按默认跳过"; return 1; fi
  local hint="[Y/n]"; [ "$def" = "n" ] && hint="[y/N]"
  read -rp "  ${CY}?${C0} $q $hint " ans || ans=""
  ans=$(echo "$ans" | tr '[:upper:]' '[:lower:]'); [ -z "$ans" ] && ans="$def"
  [ "$ans" = "y" ] || [ "$ans" = "yes" ]
}
die() { echo -e "${CR}中止：$*${C0}"; exit 1; }

h "部署前体检"
command -v node >/dev/null 2>&1 || die "未找到 node，请先跑 bash deploy/setup-ubuntu2204.sh --check"
ok "Node $(node -v)"
[ -f server/index.js ] || die "当前目录不是项目根目录（未找到 server/index.js）"
ok "源码目录: $(pwd)"
command -v rsync >/dev/null 2>&1 || die "未找到 rsync，请先 apt-get install -y rsync"

# 目标目录现状
if [ -d "$APP_DIR" ]; then
  ok "目标目录已存在: $APP_DIR"
  [ -f "$APP_DIR/package.json" ] && ok "已有代码（本次为更新）" || warn "目录存在但无代码（首次写入）"
  if [ -f "$APP_DIR/data/app.db" ]; then
    warn "已存在数据库 app.db（$(du -h "$APP_DIR/data/app.db" 2>/dev/null | cut -f1)）→ 只备份，绝不删除或重置"
  else
    info "尚无数据库，首次启动会初始化"
  fi
  [ -f "$APP_DIR/data/.appsecret" ] && ok "主密钥 .appsecret 存在" || warn "缺少 .appsecret（首次启动自动生成）"
else
  info "目标目录不存在，本次将创建"
  [ "$INIT" = "1" ] || warn "首次部署建议加 --init（会建运行用户并装依赖）"
fi

# 端口
if ss -ltn 2>/dev/null | grep -qE ":3000\s"; then
  warn "端口 3000 已被占用：$(ss -ltnp 2>/dev/null | grep -E ':3000\s' | grep -o 'users:(("[^"]*"' | cut -d'"' -f2)"
  info "若非本项目占用，请在 deploy/ecosystem.config.cjs 里把 PORT 改成空闲端口"
else
  ok "端口 3000 空闲"
fi

# 预计变更
[ -d "$APP_DIR" ] && info "预计变更文件数：$(rsync -a --dry-run --out-format='%n' \
  --exclude 'node_modules/' --exclude 'data/' --exclude '.git/' --exclude 'tools/*.log' \
  ./ "$APP_DIR/" 2>/dev/null | wc -l)"

if [ "$CHECK_ONLY" = "1" ]; then echo -e "\n${CB}（--check 模式：未做任何改动）${C0}"; exit 0; fi

echo
if [ -f "$APP_DIR/data/app.db" ]; then
  warn "即将覆盖 $APP_DIR 下的代码文件（data/ 保留）"
  ask "确认继续？会先备份数据库" y || die "已取消"
else
  ask "确认部署到 $APP_DIR？" y || die "已取消"
fi

# ---------- 执行 ----------
if [ "$INIT" = "1" ]; then
  h "初始化运行用户与目录"
  id -u $APP_USER >/dev/null 2>&1 || useradd -r -s /bin/bash -d "$APP_DIR" $APP_USER
  mkdir -p "$APP_DIR" /var/log/blcloud
  chown -R $APP_USER:$APP_USER "$APP_DIR" /var/log/blcloud 2>/dev/null
  ok "用户与目录就绪"
fi

h "备份现有数据（在改代码之前）"
if [ -f "$APP_DIR/data/app.db" ]; then
  if [ -f "$APP_DIR/deploy/backup.js" ]; then
    (cd "$APP_DIR" && node deploy/backup.js "$APP_DIR/data/backups") && ok "数据库已备份" \
      || { cp -a "$APP_DIR/data/app.db" "$APP_DIR/data/app.db.bak-$TS" && ok "已用 cp 兜底备份"; }
  else
    cp -a "$APP_DIR/data/app.db" "$APP_DIR/data/app.db.bak-$TS" && ok "已备份 app.db"
  fi
else
  info "无数据库，跳过"
fi

h "同步代码（排除 node_modules 与 data）"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude '.git/' \
  --exclude 'tools/*.log' \
  ./ "$APP_DIR/" && ok "代码同步完成"
cd "$APP_DIR" || die "无法进入 $APP_DIR"

h "依赖"
if [ -d node_modules ] && [ -f node_modules/better-sqlite3/package.json ]; then
  ok "依赖已存在"
  ask "重新 npm ci？（仅在原生模块或依赖有更新时需要，较慢）" n && \
    npm ci --omit=dev --cache "$APP_DIR/.npm-cache" && ok "依赖已更新"
else
  info "首次安装依赖（better-sqlite3 需本地编译，约 1-3 分钟）"
  npm ci --omit=dev --cache "$APP_DIR/.npm-cache" \
    || npm install --omit=dev --cache "$APP_DIR/.npm-cache" \
    || die "依赖安装失败，常见原因：缺少 build-essential / python3，或 Node 版本不是 22"
  ok "依赖安装完成"
fi
mkdir -p "$APP_DIR/data/uploads"
chown -R $APP_USER:$APP_USER "$APP_DIR" 2>/dev/null

h "重启服务"
if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q "blcloud"; then
  pm2 startOrReload deploy/ecosystem.config.cjs --update-env && pm2 save && ok "PM2 已重载"
elif command -v pm2 >/dev/null 2>&1; then
  ask "PM2 中尚未注册本项目，现在启动？" y && pm2 start deploy/ecosystem.config.cjs && pm2 save && ok "PM2 已启动"
elif systemctl list-unit-files 2>/dev/null | grep -q "^blcloud.service"; then
  systemctl restart blcloud && ok "systemd 已重启"
else
  warn "未检测到 pm2 或 systemd 服务，未启动"
  info "手动启动：cd $APP_DIR && NODE_ENV=production PORT=3000 node server/index.js"
fi

h "健康检查"
sleep 2

# 读取运行时端口与子路径前缀（用了 BASE_PATH 时 /api/health 不在根路径，写死会误报失败）
PORT=3000; BASE_PATH=""
probe_runtime() {
  local j=""
  command -v pm2 >/dev/null 2>&1 && j=$(pm2 jlist 2>/dev/null)
  if [ -n "$j" ]; then
    eval "$(printf '%s' "$j" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const a=JSON.parse(s)||[];const p=a.find(x=>/blcloud/.test(x.name||""))||a[0]||{};
        const e=p.pm2_env||{};console.log("PORT="+(e.PORT||""));console.log("BASE_PATH="+(e.BASE_PATH||""));
        }catch(err){console.log("PORT=");console.log("BASE_PATH=");}});' 2>/dev/null)"
  fi
  if [ -z "$PORT" ] && [ -f "$1" ]; then
    PORT=$(node -e 'try{const c=require(process.argv[1]);console.log((c.apps[0].env||{}).PORT||3000)}catch(e){console.log(3000)}' "$1" 2>/dev/null)
    BASE_PATH=$(node -e 'try{const c=require(process.argv[1]);console.log((c.apps[0].env||{}).BASE_PATH||"")}catch(e){console.log("")}' "$1" 2>/dev/null)
  fi
  [ -z "$PORT" ] && PORT=3000
  BASE_PATH=$(printf '%s' "$BASE_PATH" | tr -d '/' | tr -d ' ')
}
probe_runtime "$APP_DIR/deploy/ecosystem.config.cjs"
PREFIX=""; [ -n "$BASE_PATH" ] && PREFIX="/$BASE_PATH"
HEALTH="http://127.0.0.1:${PORT}${PREFIX}/api/health"
info "探测地址: $HEALTH"

if curl -fsS --noproxy '*' --max-time 5 "$HEALTH"; then
  echo; ok "服务正常"
  ADMIN_URL="https://你的域名${PREFIX}/admin/"
  [ -n "$PREFIX" ] && info "子路径部署已生效 → 后台地址形如 $ADMIN_URL"
else
  bad "健康检查失败（服务未在 ${PORT} 端口响应）"
  info "看日志：pm2 logs blcloud-admin   或   journalctl -u blcloud -n 100"
  if [ -n "$PREFIX" ]; then
    info "子路径模式下确认 BASE_PATH 已生效：改完 ecosystem.config.cjs 必须执行"
    info "  pm2 restart blcloud-admin --update-env   否则环境变量不生效"
  fi
  exit 1
fi

h "部署完成"
[ -f "$APP_DIR/data/admin-init-password.txt" ] && \
  echo -e "  ${CY}初始管理员密码：sudo cat $APP_DIR/data/admin-init-password.txt （登录后立即修改）${C0}"
info "线上务必确认：站点设置 → 演示模式 = 强制关闭"
