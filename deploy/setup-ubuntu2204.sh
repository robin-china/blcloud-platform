#!/usr/bin/env bash
# blcloud 部署前置环境脚本（Ubuntu 22.04）——只读体检 + 逐项确认，绝不破坏现有环境
#
#   bash deploy/setup-ubuntu2204.sh --check [域名]   # 只体检，不改任何东西
#   bash deploy/setup-ubuntu2204.sh [域名]           # 体检 → 逐项询问 → 执行
#   ASSUME_YES=1 bash deploy/setup-ubuntu2204.sh ... # 非交互，全部按推荐值执行
#
# 安全原则：
#   1. 默认只读；任何写操作都要你确认
#   2. 不动现有 ufw 规则（只补缺失的，绝不 reset）
#   3. 不覆盖已有 /opt/blcloud/data（升级场景只备份不删除）
#   4. 不自动升级已装的 Node（可能影响同机其他项目）
#   5. 覆盖任何文件前先带时间戳备份
set -uo pipefail

APP_DIR=/opt/blcloud
APP_USER=blcloud
DOMAIN=""
CHECK_ONLY=0
TS=$(date +%Y%m%d-%H%M%S)

# ---------- 参数 ----------
for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;;
    --yes) ASSUME_YES=1 ;;
    -*) echo "未知参数: $a"; exit 1 ;;
    *) DOMAIN="$a" ;;
  esac
done
ASSUME_YES=${ASSUME_YES:-0}

# ---------- 输出 ----------
if [ -t 1 ]; then
  C0=$'\033[0m'; CC=$'\033[36m'; CG=$'\033[32m'; CY=$'\033[33m'; CR=$'\033[31m'; CB=$'\033[1m'
else
  C0=""; CC=""; CG=""; CY=""; CR=""; CB=""
fi
h()   { echo -e "\n${CC}${CB}== $* ==${C0}"; }
ok()  { echo -e "  ${CG}✓${C0} $*"; }
warn(){ echo -e "  ${CY}!${C0} $*"; }
bad() { echo -e "  ${CR}✗${C0} $*"; }
info(){ echo -e "    $*"; }

# ---------- 询问 ----------
# ask "问题" <默认 y|n>，返回 0 表示同意
ask() {
  local q="$1" def="${2:-y}" ans
  if [ "$ASSUME_YES" = "1" ]; then
    echo -e "  ${CY}?${C0} $q  ${def}（自动确认）"
    [ "$def" = "y" ] && return 0 || return 1
  fi
  if [ ! -t 0 ]; then
    echo -e "  ${CY}?${C0} $q  无交互终端，按默认 ${def} 跳过"
    return 1
  fi
  local hint="[Y/n]"; [ "$def" = "n" ] && hint="[y/N]"
  read -rp "  ${CY}?${C0} $q $hint " ans || ans=""
  ans=$(echo "$ans" | tr '[:upper:]' '[:lower:]')
  [ -z "$ans" ] && ans="$def"
  [ "$ans" = "y" ] || [ "$ans" = "yes" ]
}

# 覆盖前备份
backup_file() {
  local f="$1"
  [ -f "$f" ] || return 0
  cp -a "$f" "${f}.bak-${TS}"
  info "已备份原文件 → ${f}.bak-${TS}"
}

# ---------- 体检 ----------
declare -A ST          # 状态
NEED_NODE=0; NEED_NGINX=0; NEED_PM2=0; NEED_CERTBOT=0
HAS_DB=0; HAS_CODE=0; PORT3000_BUSY=""; UFW_ACTIVE=0; CERT_FROM="none"

h "1/7 系统与资源"
ST[os]="$( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo "未知" )"
if grep -qi "ubuntu 22.04" <<<"${ST[os]}"; then ok "系统: ${ST[os]}"
elif grep -qi ubuntu <<<"${ST[os]}"; then warn "系统: ${ST[os]}（本脚本按 22.04 编写，其他版本请留意差异）"
else warn "系统: ${ST[os]}（非 Ubuntu，脚本未针对此系统验证）"; fi
info "内核: $(uname -r)  架构: $(uname -m)"
info "内存: $(free -h 2>/dev/null | awk '/^Mem:/{print $2" 总量, "$7" 可用"}')"
info "磁盘: $(df -h /opt 2>/dev/null | awk 'NR==2{print $4" 可用（"$5" 已用）"}')"
if [ "$(id -u)" = "0" ]; then ok "当前是 root"; else warn "当前非 root，安装类操作会失败（体检不受影响）"; fi

h "2/7 运行时：Node / npm"
if command -v node >/dev/null 2>&1; then
  NV=$(node -v); NMAJ=$(echo "$NV" | tr -d 'v' | cut -d. -f1)
  if [ "$NMAJ" = "22" ]; then ok "Node $NV（符合要求）"
  else
    warn "Node $NV（本项目要求 22；better-sqlite3 是原生模块，大版本必须一致）"
    NEED_NODE=2   # 已装但版本不符 —— 不自动覆盖，交给用户决定
  fi
  info "路径: $(command -v node)"
else
  bad "未安装 Node"; NEED_NODE=1
fi
command -v npm >/dev/null 2>&1 && ok "npm $(npm -v 2>/dev/null)" || warn "未找到 npm"

h "3/7 Web 与进程管理"
if command -v nginx >/dev/null 2>&1; then
  ok "Nginx $(nginx -v 2>&1 | awk -F'/' '{print $2}')"
  if systemctl is-active --quiet nginx; then ok "Nginx 运行中"
  else warn "Nginx 已装但未运行（如需启动请自己确认，脚本不会擅自启停）"; fi
  info "配置目录: $(nginx -V 2>&1 | grep -o 'conf-path=[^ ]*' | cut -d= -f2 | xargs dirname 2>/dev/null)"
  info "已有站点数: $(ls -1 /etc/nginx/conf.d/*.conf 2>/dev/null | wc -l)（本脚本只会新增 blcloud.conf，不动其他）"
else
  bad "未安装 Nginx"; NEED_NGINX=1
fi

if command -v pm2 >/dev/null 2>&1; then
  ok "PM2 $(pm2 --version 2>/dev/null)"
  if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q "blcloud"; then
    warn "PM2 中已存在 blcloud 进程，脚本不会擅自重启它"
  fi
else
  warn "未安装 PM2（也可以改用 systemd，两种都可以）"; NEED_PM2=1
fi

if command -v certbot >/dev/null 2>&1; then
  ok "Certbot $(certbot --version 2>/dev/null | awk '{print $2}')"
  if systemctl is-enabled certbot.timer >/dev/null 2>&1; then ok "证书自动续期已开启"; else warn "证书自动续期未开启"; fi
else
  warn "未安装 Certbot"; NEED_CERTBOT=1
fi
systemctl list-unit-files 2>/dev/null | grep -q "^blcloud.service" && ok "已存在 systemd 服务 blcloud" || info "未注册 systemd 服务（用 PM2 就不需要）"

h "4/7 端口占用"
for p in 80 443 3000; do
  who=$(ss -ltnp 2>/dev/null | grep -E ":$p\s" | head -1)
  if [ -n "$who" ]; then
    proc=$(echo "$who" | grep -o 'users:(("[^"]*"' | cut -d'"' -f2)
    if [ "$p" = "3000" ]; then
      # 可能是本项目自己占着（已部署过），那不是冲突
      if ps -eo args 2>/dev/null | grep -q "[b]lcloud"; then
        ok "端口 3000 已被本项目占用 → ${proc:-node}（说明服务已在运行，非冲突）"
      else
        warn "端口 $p 被占用 → ${proc:-未知进程}"
        PORT3000_BUSY="${proc:-未知}"
        info "本项目默认用 3000；若被别的程序占了，部署时可换 PORT（如 3100）"
      fi
    else
      ok "端口 $p 使用中 → ${proc:-未知进程}（Web 端口本就该占用）"
    fi
  else
    [ "$p" = "3000" ] && ok "端口 3000 空闲" || warn "端口 $p 未监听"
  fi
done

h "5/7 防火墙"
if command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -qi "^Status: active"; then
    UFW_ACTIVE=1; ok "ufw 已启用（现有规则保持不动）"
    ufw status 2>/dev/null | grep -E "^\s*[0-9]+" | sed 's/^/    /' | head -8
    for p in 22 80 443; do
      ufw status 2>/dev/null | grep -qE "^\s*${p}/tcp.*ALLOW" || warn "未放行 ${p}/tcp（部署需要，待会儿问你要不要加）"
    done
  else
    warn "ufw 已装但未启用"
    info "⚠ 启用 ufw 有断连风险（若 SSH 不在放行列表里）。脚本会先确认再动。"
  fi
else
  warn "未使用 ufw（可能用云厂商安全组，那就不用管）"
  info "请确认云控制台安全组已放行 80/443，且**不要**放行 3000"
fi

h "6/7 应用目录 /opt/blcloud"
if [ -d "$APP_DIR" ]; then
  ok "目录已存在"
  [ -f "$APP_DIR/package.json" ] && { HAS_CODE=1; ok "已有代码"; } || warn "目录存在但没有代码（首次部署会写入）"
  if [ -f "$APP_DIR/data/app.db" ]; then
    HAS_DB=1
    warn "已存在数据库 app.db（$(du -h "$APP_DIR/data/app.db" 2>/dev/null | cut -f1)）"
    info "⚠ 这是**升级**场景：脚本只会备份，绝不删除或重置"
  fi
  [ -f "$APP_DIR/data/.appsecret" ] && ok "主密钥 .appsecret 存在（务必随库一起备份）" || warn "缺少 .appsecret（首次启动会自动生成）"
  id -u $APP_USER >/dev/null 2>&1 && ok "运行用户 $APP_USER 已存在" || info "运行用户 $APP_USER 未创建"
else
  info "目录不存在（首次部署将创建）"
fi

h "7/7 域名与网络"
if [ -n "$DOMAIN" ]; then
  info "目标域名: $DOMAIN"
  rip=""
  if command -v dig >/dev/null 2>&1; then rip=$(dig +short "$DOMAIN" A 2>/dev/null | head -1); fi
  [ -z "$rip" ] && rip=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
  # 本机没有 dig/getent 时用 python 兜底，避免误报"未解析"
  [ -z "$rip" ] && command -v python3 >/dev/null 2>&1 && \
    rip=$(python3 -c "import socket;print(socket.gethostbyname('$DOMAIN'))" 2>/dev/null | head -1)
  pip=$(curl -s -4 --max-time 5 ifconfig.me 2>/dev/null || curl -s -4 --max-time 5 ip.sb 2>/dev/null || echo "")
  [ -n "$pip" ] && info "本机公网 IP: $pip" || info "未能获取公网 IP"

  # 先探 443 是否已有 HTTPS，再判断解析，避免本机 DNS 工具缺失时误报"未解析"
  CERT_FROM="none"
  if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    CERT_FROM="letsencrypt"
    ok "已有 Let's Encrypt 证书"
    info "到期: $(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" 2>/dev/null | cut -d= -f2)"
  elif command -v openssl >/dev/null 2>&1 && \
       timeout 8 openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" </dev/null 2>/dev/null | grep -q "BEGIN CERTIFICATE"; then
    CERT_FROM="existing"
    ok "该域名 443 已有 HTTPS 证书（商业证书等）—— 不会重复申请"
    info "签发者: $(timeout 8 openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" </dev/null 2>/dev/null \
      | openssl x509 -noout -issuer 2>/dev/null | sed 's/issuer=//')"
    info "到期:   $(timeout 8 openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" </dev/null 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  else
    info "尚无该域名证书"
  fi

  if [ -n "$rip" ]; then info "域名解析到: $rip"
  elif [ "$CERT_FROM" != "none" ]; then info "本机查不到 A 记录，但 443 已可连通 → 解析实际已生效"
  else warn "未解析到 A 记录（申请证书会失败，请先解析）"; fi
  if [ -n "$rip" ]; then
    if [ "$rip" = "$pip" ]; then
      ok "解析($rip) 与本机公网 IP 一致"
    elif hostname -I 2>/dev/null | tr ' ' '\n' | grep -qx "$rip"; then
      ok "解析($rip) 命中本机网卡地址"
    elif [ "$CERT_FROM" != "none" ]; then
      info "解析($rip) 与本机公网 IP($pip) 不同 —— 走 CDN / 负载均衡 / NAT 时属正常"
    else
      warn "解析($rip) 与本机公网 IP($pip) 不一致，请确认这台就是目标服务器"
    fi
  fi
else
  warn "未指定域名，跳过域名与证书检查"
  info "用法: bash deploy/setup-ubuntu2204.sh your-domain.com"
fi

# ---------- 体检结论 ----------
h "体检结论"
TODO=()
[ "$NEED_NODE" = "1" ] && TODO+=("安装 Node 22")
[ "$NEED_NODE" = "2" ] && TODO+=("Node 版本不符（需你决定是否替换，脚本不会自动动它）")
[ "$NEED_NGINX" = "1" ] && TODO+=("安装 Nginx")
[ "$NEED_PM2" = "1" ] && TODO+=("安装 PM2（或用 systemd）")
# 已有 HTTPS 证书时不必装 Certbot（商业证书 / 已有 Lets Encrypt 都不需要）
[ "$NEED_CERTBOT" = "1" ] && [ "$CERT_FROM" = "none" ] && TODO+=("安装 Certbot（用于申请/续期免费证书）")
[ -n "$PORT3000_BUSY" ] && TODO+=("3000 端口被 ${PORT3000_BUSY} 占用，需改用其他端口")
[ "$HAS_DB" = "1" ] && TODO+=("检测到既有数据库 → 走升级流程，先备份")
[ -n "$DOMAIN" ] && [ "$CERT_FROM" = "none" ] && TODO+=("申请 HTTPS 证书")
if [ ${#TODO[@]} -eq 0 ]; then echo -e "  ${CG}环境已就绪，没有必须处理的事项${C0}"; else
  for i in "${!TODO[@]}"; do echo -e "  ${CY}$((i+1)). ${TODO[$i]}${C0}"; done
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo -e "\n${CB}（--check 模式：未做任何改动）${C0}"
  exit 0
fi

# ---------- 执行：逐项询问 ----------
echo -e "\n${CB}下面每一步都会先问你，默认回车=执行推荐项，输入 n 跳过。${C0}"

if [ "$NEED_NODE" = "1" ]; then
  h "安装 Node 22"
  info "将通过 NodeSource 安装，会新增/更新系统的 node 与 npm"
  if ask "安装 Node.js 22 LTS？" y; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y && apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs && ok "Node 安装完成: $(node -v)"
  else info "已跳过"; fi
elif [ "$NEED_NODE" = "2" ]; then
  h "Node 版本不符"
  warn "当前 $(node -v)，项目要求 22。同机若有其他 Node 项目，升级会影响它们。"
  info "推荐做法：用 nvm 装 22 并只给本项目用，或让本项目单独指定 Node 路径"
  info "手动替换（会覆盖系统 node）：curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
  info "脚本不会自动替换，请自行决定"
fi

if [ "$NEED_NGINX" = "1" ]; then
  h "安装 Nginx"
  if ask "安装 Nginx？" y; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y nginx && ok "Nginx 安装完成"
    ask "立即启动并设置开机自启？" n && systemctl enable --now nginx && ok "Nginx 已启动"
  else info "已跳过"; fi
fi

if [ "$NEED_CERTBOT" = "1" ] && [ "$CERT_FROM" = "none" ]; then
  h "安装 Certbot"
  if ask "安装 certbot 与 nginx 插件？" y; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y certbot python3-certbot-nginx && ok "Certbot 安装完成"
  else info "已跳过"; fi
fi

if [ "$NEED_PM2" = "1" ]; then
  h "进程守护"
  if ask "安装 PM2？（选 n 则稍后用 systemd）" y; then
    npm install -g pm2 && ok "PM2 $(pm2 --version)"
  else
    info "已跳过，稍后可用：cp deploy/blcloud.service /etc/systemd/system/ && systemctl enable --now blcloud"
  fi
fi

# 目录与用户（幂等，不破坏）
h "应用目录与运行用户"
if [ ! -d "$APP_DIR" ] || ! id -u $APP_USER >/dev/null 2>&1; then
  if ask "创建 $APP_DIR、$APP_USER 与日志目录？" y; then
    id -u $APP_USER >/dev/null 2>&1 || useradd -r -m -s /bin/bash -d "$APP_DIR" $APP_USER
    mkdir -p "$APP_DIR/data/uploads" /var/log/blcloud
    chown -R $APP_USER:$APP_USER "$APP_DIR" /var/log/blcloud
    ok "目录与用户就绪"
  else info "已跳过"; fi
else
  ok "目录与用户已存在，无需改动"
fi

# 防火墙：只补规则，绝不 reset
h "防火墙（只补放行规则，不动现有规则）"
if command -v ufw >/dev/null 2>&1; then
  if [ "$UFW_ACTIVE" = "1" ]; then
    for p in 22 80 443; do
      ufw status 2>/dev/null | grep -qE "^\s*${p}/tcp.*ALLOW" || {
        ask "放行 ${p}/tcp？" y && ufw allow ${p}/tcp >/dev/null && ok "已放行 ${p}/tcp"
      }
    done
  else
    warn "ufw 当前未启用"
    if ask "启用 ufw？（风险：若 22 未放行会断掉 SSH，脚本会先放行 22）" n; then
      ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
      ufw --force enable >/dev/null && ok "ufw 已启用（22/80/443 已放行）"
    else info "已跳过（若用云安全组，请自行确认 80/443 放通、3000 不放通）"; fi
  fi
else
  info "未装 ufw，跳过"
fi

# 证书：已有证书（商业证书等）时绝不重复申请
if [ -n "$DOMAIN" ] && [ "$CERT_FROM" = "none" ] && command -v certbot >/dev/null 2>&1; then
  h "HTTPS 证书"
  warn "申请前需确认：$DOMAIN 已解析到本机、80 端口对外可达、国内服务器需已备案"
  if ask "现在申请 Let's Encrypt 证书？" n; then
    certbot certonly --nginx -d "$DOMAIN" --agree-tos --register-unsafely-without-email && ok "证书获取成功" \
      || warn "证书获取失败（多为解析未生效/未备案/80 被墙）。解析生效后重跑：certbot certonly --nginx -d $DOMAIN"
  else info "已跳过"; fi
elif [ "$CERT_FROM" = "existing" ]; then
  h "HTTPS 证书"
  ok "检测到已有证书，跳过申请（不去动你的证书）"
elif [ "$CERT_FROM" = "letsencrypt" ]; then
  h "HTTPS 证书"
  ok "已有 Let's Encrypt 证书，跳过申请"
fi

# 备份定时任务
h "数据库备份定时任务"
if [ -d "$APP_DIR" ]; then
  CRON="10 3 * * * cd $APP_DIR && /usr/bin/node deploy/backup.js $APP_DIR/data/backups >> /var/log/blcloud/backup.log 2>&1"
  if crontab -l 2>/dev/null | grep -q "deploy/backup.js"; then
    ok "备份定时任务已存在"
  elif ask "添加每天 03:10 的备份定时任务？" y; then
    ( crontab -l 2>/dev/null | grep -v "deploy/backup.js"; echo "$CRON" ) | crontab - && ok "已添加"
  else info "已跳过"; fi
fi

# ---------- 后续 ----------
h "接下来（需你手动执行，脚本不会替你推代码）"
cat <<EOF
  1) 体检复跑：      bash deploy/setup-ubuntu2204.sh --check $DOMAIN
  2) 推代码：        bash deploy/deploy.sh $( [ "$HAS_CODE" = "1" ] && echo "" || echo "--init" )
  3) 配 Nginx：      sudo sed -i 's/your-domain.com/$DOMAIN/g' $APP_DIR/deploy/nginx.conf
                     sudo cp $APP_DIR/deploy/nginx.conf /etc/nginx/conf.d/blcloud.conf
                     sudo nginx -t && sudo systemctl reload nginx
EOF
[ "$HAS_DB" = "1" ] && echo -e "  ${CY}注意：检测到既有数据库，deploy.sh 会先备份再更新，不会清库${C0}"
[ -n "$PORT3000_BUSY" ] && echo -e "  ${CY}注意：3000 被 ${PORT3000_BUSY} 占用，请在 ecosystem.config.cjs 里把 PORT 改成空闲端口${C0}"
[ -n "$DOMAIN" ] && cat <<EOF

  4) 初始管理员密码： sudo cat $APP_DIR/data/admin-init-password.txt

微信服务号后台：
  服务器地址(URL)   https://$DOMAIN/api/wechat/server
  网页授权域名      $DOMAIN
  IP 白名单          ${pip:-<本机公网IP>}
微信支付商户平台：
  支付回调域名      $DOMAIN （路径 /api/pay/notify/wxpay 自动拼）
EOF
echo
