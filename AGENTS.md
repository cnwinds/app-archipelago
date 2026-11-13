# App Archipelago（应用群岛）

用 3D 群岛地图展示 Web 应用/游戏的导航站原型。每个类别是一座岛，精品是城堡，新作品带光柱。

## 项目结构

- `index.html`：页面骨架与 HUD（顶栏、类别面板、Tweaks 面板、试玩弹窗）
- `src/main.js`：渲染器、相机控制、昼夜预设、光效强度、交互逻辑
- `src/world.js`：程序化生成岛屿、建筑、主题道具、海面与天空
- `src/data.js`：类别与示例作品数据（目前为演示数据）
- `src/style.css`：HUD 样式
- `scripts/shot.mjs`：用 puppeteer-core 驱动本机 Chrome 截图，输出到 `shots/`（已 gitignore）

技术栈：Three.js + Vite，纯静态前端，无后端。

## 本地开发

```powershell
npm install
npx vite --port 5317        # 截图脚本默认访问 http://localhost:5317/
node scripts/shot.mjs       # 生成 shots/*.png，并打印 fps
npm run build               # 产物在 dist/
```

光效相关参数集中在 `src/main.js` 的 `PRESETS`（bloom / glow / exposure）和 `FX_LEVELS`（柔和 / 标准 / 绚丽，存于 localStorage `archipelago.fx`）。用户反馈过光效晃眼，调参时偏保守。

## 部署

- 线上地址：`https://isle.ai-news.top/`
- 服务器：`root@101.132.237.21`（Alibaba Cloud Linux 3，Docker 26 + Compose v2），已配置本机 `~/.ssh/id_ed25519` 免密登录
- 代码目录：`/opt/app-archipelago`（从 GitHub `cnwinds/app-archipelago` 克隆）
- 容器：`app-archipelago`，Nginx 托管静态文件，只绑定 `127.0.0.1:5320`
- 服务器 `/opt/app-archipelago/.env` 设置了 `NPM_REGISTRY=https://registry.npmmirror.com`（国内 npm 镜像，不入库）
- Docker 镜像加速已在服务器 `/etc/docker/daemon.json` 配置

更新上线（先把代码推到 GitHub）：

```powershell
ssh root@101.132.237.21 "cd /opt/app-archipelago && git pull && docker compose up -d --build"
```

### 前端代理（Caddy）

- 服务器 80/443 由 Caddy 统一占用，配置在 `/etc/caddy/Caddyfile`，按 `*.ai-news.top` 子域名反代到各服务的本机端口，自动申请 HTTPS 证书
- 本项目的规则：`isle.ai-news.top { encode zstd gzip; reverse_proxy 127.0.0.1:5320 }`
- 改 Caddyfile 前先备份（惯例命名 `Caddyfile.bak.<项目>-<时间>`），用 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 校验通过后再 `systemctl reload caddy`。机器上还有十几个其他站点，不要重启 Caddy
- 新增服务时选一个未占用端口并只绑定 `127.0.0.1`，先用 `ss -ltn` 检查

### DNS

- `ai-news.top` 托管在 DNSPod（腾讯云），没有泛解析，每个新子域名都要在 DNSPod 手动加 A 记录指向 `101.132.237.21`
- 服务器上的 `aliyun` 命令行管不了这个域名的 DNS

## Windows 本机环境注意事项

- 本机 shell 是 Windows PowerShell 5.1：
  - 远程命令里不要嵌套双引号，也不要写 `$var`，会被 PowerShell 吞掉或转义错。复杂命令写成 `.sh` 文件，`scp` 到服务器后执行
  - 本地写出的脚本是 CRLF 换行，执行前用 `sed -i 's/\r$//' file` 转换
- 不要用 `Get-Content xxx.pub | ssh ...` 往服务器写 `authorized_keys`：PowerShell 管道会加 UTF-8 BOM 和 CRLF，导致密钥失效
- `~/.ssh/config` 曾因继承了一个已删除账户的写权限，被 OpenSSH 拒绝读取（已修复）。如果再出现 `Bad owner or permissions`，检查 `icacls`，用 `GetAccessControl('Access')` / `SetAccessControl` 删除对应 ACE（`Set-Acl` 会因缺少 SeSecurityPrivilege 失败）
- 本机没有 `gh` 和 `winget`；GitHub 推送走 SSH（账号 `cnwinds`）
- 本机 DNS 查询会拿到代理的 `198.18.x.x` 假 IP，验证解析要到服务器上执行 `getent ahostsv4 <域名>`
