/* PM2 进程守护配置：pm2 start deploy/ecosystem.config.cjs */
module.exports = {
  apps: [
    {
      name: 'blcloud-admin',
      script: 'server/index.js',
      cwd: '/opt/blcloud',
      instances: 1,           // SQLite + 单文件写，只能单进程，不要改
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        // 子路径部署时取消注释，并同步配置 deploy/nginx-subpath.conf
        // 改完必须 pm2 restart blcloud-admin --update-env 才生效
        // BASE_PATH: 'platform',   // → www.bliot.cn/platform/admin/
        TRUST_PROXY: '1',
      },
      // 日志落盘：默认 pm2 日志在 ~/.pm2/logs
      out_file: '/var/log/blcloud/out.log',
      error_file: '/var/log/blcloud/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
