# App Archipelago（应用群岛）

用 3D 群岛地图展示 Web 应用/游戏的导航站原型。每个类别是一座岛，精品是城堡，新作品带光柱。

## 项目结构

- `index.html`：页面骨架与 HUD（顶栏、类别面板、Tweaks 面板、试玩弹窗）
- `src/main.js`：渲染器、相机控制、昼夜预设、光效强度、交互逻辑
- `src/world.js`：程序化生成岛屿、建筑、主题道具、海面与天空
- `src/data.js`：六个类别的定义；作品从 `catalog/published.json` 读取（构建时打包进去）
- `src/style.css`：HUD 样式
- `scripts/shot.mjs`：用 puppeteer-core 驱动本机 Chrome 截图，输出到根目录 `shots/`（已 gitignore，临时验证脚本也放这里）
- `scripts/catalog/`：作品收录流水线，见下一节
- `catalog/`：流水线的数据文件和全部候选的截图（`catalog/shots/`，不对外）
- `public/catalog/shots/`：只含已发布作品的封面，由发布脚本从 `catalog/shots/` 复制过来（要入库，服务器构建时需要；不要手动往里放图，发布时会清掉多余文件）

技术栈：Three.js + Vite，纯静态前端，无后端。每个作品有独立链接 `/#/app/<id>`。

## 作品收录流水线

候选有两个来源（自动发现、手工添加），之后三步，各自一个脚本，中间结果都是 `catalog/` 下的 JSON：

| 步骤 | 命令 | 读 | 写 |
|---|---|---|---|
| 发现 | `npm run catalog:discover -- --days 45 --min-points 30 --limit 90` | Show HN 接口 | `catalog/sources.json`（候选） |
| 手工添加 | `npm run catalog:add -- <网址> [<网址> ...]` | 命令行 | `catalog/sources.json`（没有 `source` 字段的候选） |
| 体检取素材 | `npm run catalog:ingest -- --concurrency 3` | `sources.json` | `catalog/drafts.json`、`catalog/shots/<id>.webp` |
| 审核 | `npm run catalog:review` 生成 `catalog/review.html`（不入库），对着它手写 `catalog/curation.json` | `drafts.json` | `curation.json` |
| 发布 | `npm run catalog:publish` | 以上三个 | `catalog/published.json`（前端读这个，不要手改）、`public/catalog/shots/` |

- `curation.json` 按作品 id 记录人工决定：`status`（`approved` / `rejected`）、`category`、`name`、`tags`、`blurb`，拒绝时写 `reason`。可选 `score`（覆盖品质分）和 `"embed": false`（强制新标签页打开，比如需要麦克风的作品）
- 中文介绍只写作品页面自己说了的内容，不确定的不写；收录标准是“点开就能用，不用下载或注册”
- 品质分目前只有一个真实信号：`20 + 25.5 × log10(HN 分数)`，限制在 40 到 99。90 以上是城堡，70 以上是房屋。“新作”指发布 3 天内，不要为了好看放宽
- 手工添加的作品没有发布日期和热度信号：不显示发布时间，永远不算“新作”，品质分默认 60，要更显眼只能由审核人在 `curation.json` 里写 `score`。首批 15 个经典作品统一给了 80，是人为定的占位值
- 有些站点用 Cloudflare 质询拦截自动访问（neal.fun、shadertoy.com、slowroads.io 返回 403），流水线验证不了，体检记为失败。不要伪装浏览器去绕过
- `ingest` 默认只处理还没有草稿的候选；`--only id,id` 重查指定作品，`--force` 全部重查，`--late 25000` 给加载慢的作品多等一会儿再截图，`--embed-shots shots/embed` 保存嵌入后的画面供人工复查

体检脚本的几个设计点，改之前先了解：

- **嵌入检测是真的放进 iframe 里跑**，父页面伪装成 `https://isle.ai-news.top`，iframe 的 `sandbox` 属性要和 `src/main.js` 的 `openPlay()` 保持一致。只看响应头不够
- **能加载不等于能玩**：依赖跨源隔离的作品（很多 WASM 游戏移植，如 Quake）在 iframe 里加载成功但无法运行，脚本会判为 `needs-cross-origin-isolation`
- 嵌入测试必须用新开的标签页。复用刚单独打开过作品的标签页，有的作品会截出空白
- 浏览器的截图是全局串行的，并发高时单帧会超时。每帧单独容错，一帧都没拿到才算失败。并发建议不超过 3
- 重查时如果新截图的细节（文件大小）不到旧封面的一半，保留旧封面，避免网络慢的时候把封面换成加载画面。想强制换封面就先删掉图片文件
- `drafts.json` 里的 `embed.warnings` 只是给审核人看的软信号（嵌入后画面明显变空、只在嵌入时出现的报错），网络慢时会误报

### 网络可达性

- **流水线只能在能访问海外的机器上跑（目前是本机）**。阿里云服务器访问不了 Hacker News、`*.github.io`、`*.vercel.app`、`*.pages.dev`、`*.workers.dev`、itch.io、huggingface.co，或者极慢
- 用自定义域名的作品大多能从国内直接打开。`scripts/catalog/reach.sh` 可以从服务器批量探测，用法见文件头。它只测主页面，不测页面里引用的资源，结果偏乐观
- 如果要做作品代理（gh-proxy 那种思路）：上游必须在海外；每个作品要用独立子域名，不能挂在主站同源路径下，否则 iframe 的 `allow-same-origin` 会让作品拿到主站权限；只代理已发布的作品，不能做成开放代理

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
