# App Archipelago（应用群岛）

用 3D 群岛地图展示 Web 应用/游戏的导航站。每个类别是一座岛，精品是城堡，新作品带光柱。作品由服务器上的收录服务自动发现、体检、起草介绍，人工在审核台点通过后立即上线，不用重新构建。

## 项目结构

- `index.html`：页面骨架与 HUD（顶栏、类别面板、Tweaks 面板、试玩弹窗、「投稿作品」入口）
- `src/main.js`：渲染器、相机控制、昼夜预设、光效强度、交互逻辑
- `src/world.js`：程序化生成岛屿、建筑、主题道具、海面与天空
- `src/data.js`：六个类别的定义；作品在页面打开时从 `/catalog/published.json` 取（运行时读取，不打包）
- `src/style.css`：HUD 样式
- `public/submit.*`：公开投稿页（`/submit`）；`public/admin/`：审核台（`/admin/`，nginx 加口令）
- `server/`：收录服务（compose 里的 `api`）。`app.mjs` 路由与访问控制，`store.mjs` SQLite 数据层与发布，`intake.mjs` 收录规则（提交、领任务、结果、重试、审核、复查），`discover.mjs` Show HN 发现，`llm.mjs` AI 起草，`scheduler.mjs` 定时任务，`seed.mjs` 一次性导入，`urlcheck.mjs` 投稿地址校验，`config.mjs` 全部环境变量
- `worker/`：体检（compose 里的 `worker`）。`analyze.mjs` 用真实浏览器体检，`egress-proxy.mjs` 出站代理，`index.mjs` 拉任务循环
- `shared/`：api 和 worker 共用的地址规范化（`url.mjs`）、私网地址判断（`netguard.mjs`）、规则（`rules.mjs`）
- `test/`：`node:test` 测试，`npm test`
- `catalog/`：旧版“文件流水线”的最后一份快照（`sources.json`、`drafts.json`、`curation.json`、`catalog/shots/`）。只在数据库为空时由 `server/seed.mjs` 导入一次，之后不要再手改
- `scripts/shot.mjs`：用 puppeteer-core 驱动本机 Chrome 给 3D 页面截图，输出到根目录 `shots/`（已 gitignore，临时验证脚本也放这里）；`scripts/server-init.sh`：服务器首次初始化

技术栈：Three.js + Vite 前端；收录服务是零第三方依赖的 Node（内置 `node:sqlite` 和 `fetch`）；体检用 Chromium + puppeteer-core；Nginx 托管静态文件。每个作品有独立链接 `/#/app/<id>`。

## 作品收录流水线

```
Show HN 每日发现 ┐
投稿页 /submit   ├→ 队列 → worker 体检（浏览器、封面、嵌入测试）→ AI 起草 → 审核台通过 → 立即写 published.json
审核台“添加网址” ┘
```

- **候选来源三个**：api 每天自动从 Show HN 发现一次（窗口 7 天、至少 30 分，靠去重幂等）；任何人在 `/submit` 投稿；审核人在审核台点“添加网址”。审核台还有“立即发现”按钮
- **投稿永远先进审核，不会自动上线**。每个访客每天最多 5 个，全站每天 60 个，页面里有给机器人看的蜜罐字段。不接受 IP 地址、内网/本站地址、80/443 以外端口、代码仓库/应用商店/视频/文档这类链接
- **体检失败会重试**：网络类失败最多 3 次（10 分钟、6 小时后），证书错误不重试，其余 2 次，之后进审核台“失败”页，由人决定重查还是拒绝。worker 中途失联的任务会回到队列，连续 3 次后放弃
- **AI 起草**（`server/llm.mjs`）：OpenAI 兼容接口，由环境变量 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 配置（代码默认值是阿里云百炼 `qwen-plus`）。线上用的是同一台服务器上 sub2api 网关（`http://101.132.237.21:8080/v1`）的 `glm-5.3-flash`，key 只在服务器 `.env` 里。这是推理模型，思考过程会占用 `max_tokens`，所以请求上限给到 2000（500 会把 JSON 截断），单次起草约 10–40 秒，后台跑不挡 worker；起草总时限 85 秒，要小于 nginx 的 90 秒读超时（审核台“重新起草”按钮同步等它）。没有 key 时只用页面自己的标题和描述预填，分类和介绍由审核人写。AI 标出的风险只会预填“建议拒绝”，不会自动拒绝或通过；页面文字当作不可信输入处理。AI 只填审核人还没写的字段
- **页面没有文字时看封面图**：很多作品全画在 canvas 上，HTML 里只有标题（例如 p5.js 作品，页面只有 790 字节），纯文本模型没有依据，按规则会把介绍留空，而“通过”要求介绍非空，审核人就得自己写。配置 `LLM_VISION_MODEL`（同一网关、同一 key）后，文本模型没写出介绍、且有封面图时，会再让视觉模型看封面，只描述图里直接看得到的内容，空白/黑屏/加载画面则仍然留空。结果标 `blurbFrom: 'image'`，把握最高只到“中”，审核台会提示“介绍是看封面图写的，请核对”。线上用的是 `z-ai/glm-4.6v`（约 10–15 秒）；`qwen3-vl-flash` 在这个网关上会 502/429，别用。截图里的文字同样当作不可信输入
- **审核台**（`/admin/`）：待审核、检查中、失败、已上线、已拒绝/下架五个分栏；封面和“放进群岛 iframe 之后的样子”并排；键盘：J/K 上一个/下一个、A 通过、R 拒绝、E 改名称、X 勾选（用于批量）、O 打开原站、/ 搜索、1–5 切换分栏、表单里 Ctrl+Enter 通过。通过后立即重新生成 `published.json`，站点几秒内就能看到
- **每周复查已上线作品**（每 7 天一轮，每小时最多 20 个后台分析，投稿不受限）：复查失败不会下架，只在审核台标红；复查从不替换已有封面；嵌入判断里只有明确的结论（X-Frame-Options、CSP frame-ancestors、需要跨源隔离等）才会改变“能否嵌入”，超时和报错不算数。重新体检（人工触发）只在新封面细节不少于旧封面一半时才换封面
- **每晚备份**（中国时间 3 点后一次，保留 7 份）：`data/backups/app-<日期>.db` 加一份 `.curation.json` 导出，后者不依赖 sqlite 也能读
- 可选：配置 `NOTIFY_WEBHOOK`（`NOTIFY_FORMAT` 为 feishu / wecom / json）后，每天 9 点后推送一次“N 个作品等待审核”

收录与评分的规则（不要为了好看放宽）：

- 收录标准是“点开就能用，不用下载或注册”；中文介绍只写作品页面自己说了的内容，不确定的不写
- 品质分目前只有一个真实信号：`20 + 25.5 × log10(HN 分数)`，限制在 40 到 99。90 以上是城堡，70 以上是房屋。“新作”指发布 3 天内
- 没有发布日期和热度信号的作品（投稿、手工添加）：不显示发布时间，永远不算“新作”，品质分默认 60，要更显眼只能由审核人在审核台写评分。首批 15 个经典作品统一给了 80，是人为定的占位值
- 审核人可以对单个作品选“强制新标签页打开”（比如需要麦克风的作品）
- 有些站点用 Cloudflare 质询拦截自动访问（neal.fun、shadertoy.com、slowroads.io 返回 403），体检记为失败。不要伪装浏览器去绕过

体检的几个设计点，改 `worker/analyze.mjs` 之前先读它文件头的说明，要点：

- **嵌入检测是真的放进 iframe 里跑**，父页面伪装成 `https://isle.ai-news.top`，iframe 的 `sandbox` 属性要和 `src/main.js` 的 `openPlay()` 保持一致。只看响应头不够
- **能加载不等于能玩**：依赖跨源隔离的作品（很多 WASM 游戏移植，如 Quake）会判为 `needs-cross-origin-isolation`
- 嵌入测试必须用新开的标签页；浏览器截图是全局串行的，所以每帧单独容错，一帧都没拿到才算失败
- 嵌入告警 `embed.warnings`（嵌入后画面明显变空、只在嵌入时出现的报错）只是给审核人看的软信号，网络慢时会误报
- 带 canvas 的页面如果最好的一帧还小于 15 KB（多半还停在加载画面），会再等 12 秒、15 秒各补拍一帧；人工重新体检时还可以指定“晚拍”时间，给加载特别慢的作品。3D 作品需要 WebGL，容器里用 Mesa（`CHROME_GPU=mesa`），没有它所有 3D 作品都是空白封面

### 安全底线（改架构前先看）

worker 是整套系统里最不可信的部分：它要打开陌生人提交的网址，而服务器上的内网地址（阿里云元数据 `100.100.100.200`、同机其他容器的端口）是能连通的。下面这些都不能破坏：

- Chromium 必须通过 worker 自带的出站代理（`--proxy-server`，并带 `--proxy-bypass-list=<-loopback>`）。代理自己解析 DNS，只连解析结果全部是公网的地址，只放行 80/443，所以重定向、子资源和 DNS 重绑定都挡得住。不要为了“本机方便”在服务器上关掉它（`EGRESS_PROXY=0` 只给开发机用）
- 可选的海外中转（`UPSTREAM_PROXY`，默认只对 `UPSTREAM_PROXY_HOSTS=*.github.io` 生效）：这些主机的 HTTPS 隧道先过我们自己的公网地址检查，再用**检查通过的 IP**（不是域名）向中转要 CONNECT，所以中转没法被用来二次解析域名；中转不可用或拒绝时自动回退直连。只放“DNS 由平台自己管”的后缀，别加任何人都能随便指向别处的域名。走了中转的作品，加载耗时反映的是中转而不是国内访客的体验，所以 worker 一律把它们记为 `reach: slow`、`relayed: true`
- worker 不持有任何密钥，只带一个 `WORKER_TOKEN`；它只能调用 api 的 `/internal/*`，且在独立的 `back` 网络里，够不到 nginx
- api 不发布端口。公开接口和管理接口只回应来自 nginx 的请求（`EDGE_HOST=web`），所以被攻破的 worker 也碰不到管理接口。nginx 对 `/internal/` 返回 404
- 管理接口由 nginx 的 `auth_basic` 保护；管理写接口要求 JSON 请求体和同源 `Origin`，防止浏览器自动带口令造成的跨站请求
- 第三方页面的标题、介绍一律转义后再进 HTML；审核台和投稿页带严格的 CSP
- 作品 iframe 带 `allow-same-origin`，只因为作品都从自己的域名加载。永远不要把作品放到主站同源路径下

### 网络可达性

- 收录服务整套跑在阿里云服务器上，所以体检看到的是国内用户的真实体验；加载超过 15 秒的作品会标 `reach: slow`，详情面板会提示“这个作品在国内加载比较慢”
- 2026-11-17 从服务器实测：`hn.algolia.com` 200（0.45 秒）；`news.ycombinator.com`、Reddit、itch.io 不通；`*.github.io` 能通但要 7 秒左右；`*.pages.dev` 能通。之前记录的“服务器访问不了 Hacker News”不准确，发现只用 Algolia 接口，不需要访问 HN 本站。网络状况会变，别当成定论
- **GitHub 这一段丢包，别的方向没事**（2026-11-17 在服务器上实测，每项 10 次）：baidu.com 和 cloudflare 直连 0 次卡顿；`*.github.io` 直连 6/10 次超过 2 秒，中位 5.9 秒，还有超时，卡顿是 TCP 连接/TLS 握手重传，按 2 秒一档（2.2、4.2、6.2、16.2 秒）；`raw.githubusercontent.com` 好得多（2/10）。GitHub Pages 的 4 个 IP 各有快有慢，换 IP 没用。公开的 gh-proxy 实例（gh-proxy.com、ghfast.top）只代理 `github.com` 的 raw/release/archive，**不代理 `github.io`**（实测 404/403），mirror.ghproxy.com 已失效，所以“用 gh-proxy 加速体检”走不通
- 服务器上有一个别的服务的 clash（宿主机进程，`/etc/clash`，规则只有 `GEOIP,CN,DIRECT` 和 `MATCH,select`，出口在新加坡），监听 `*:7890/7891/7892`（`allow-lan: true`），**没有认证，iptables 全放行**，从 worker 容器经 Docker 网关能直接用。线上的海外中转就是它（`UPSTREAM_PROXY=http://host.docker.internal:7890`，compose 里加了 `extra_hosts: host.docker.internal:host-gateway`）。经它访问 `github.io` 中位降到约 2.4 秒、最坏约 4 秒、不再超时，但它自己的链路也会卡（访问 Google/Cloudflare 也有 3–5/10 次超过 2 秒）。它是否对公网开放取决于阿里云安全组，我在本机验证不了（本机开着 TUN 会伪造连接成功）；建议改成只监听 127.0.0.1 或加口令。注意：被攻破的 worker 能借它去连宿主机回环和内网，所以别扩大它的用途
- 用自定义域名的作品大多能从国内直接打开。上线前最初那批作品的主页面测速：49 个里 45 个能打开，2 个打不开，2 个被拒（只测主文档，偏乐观）
- 本机现在不能给线上 worker 干活：`/internal/` 不对外开放。要做的话需要另开一个受保护的入口
- 如果要做作品代理（gh-proxy 那种思路）：上游必须在海外；每个作品要用独立子域名，不能挂在主站同源路径下，否则 iframe 的 `allow-same-origin` 会让作品拿到主站权限；只代理已发布的作品，不能做成开放代理。目前没做，受影响的主要是 `*.github.io`、`*.workers.dev` 这类平台子域名作品

## 本地开发

```powershell
npm install
npm test                    # node:test，近 90 项，几秒钟
$env:CHECK_DNS='0'; npm run server    # 收录服务，默认 3000 端口，数据放 ./data（已 gitignore）
$env:CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'; $env:EGRESS_PROXY='0'; npm run worker
npx vite --port 5317        # 把 /api 和 /catalog 代理到收录服务；开发时 /admin/ 没有口令
node scripts/shot.mjs       # 生成 shots/*.png，并打印 fps
npm run build               # 产物在 dist/
```

- 本机 DNS 会拿到代理的 `198.18.x.x` 假 IP：所以 api 要 `CHECK_DNS=0`、worker 要 `EGRESS_PROXY=0`，否则每个网址都会被当成内网地址拒绝。这两个开关只用于开发机
- 数据库为空时 api 会从 `catalog/` 导入旧数据，所以开发机一启动就有 109 个候选和 64 个已上线作品
- Node 24 的 `node --test` 不能直接传目录，用 `npm test`；它不带 glob 时会把 `shots/` 里的临时脚本也当测试

光效相关参数集中在 `src/main.js` 的 `PRESETS`（bloom / glow / exposure）和 `FX_LEVELS`（柔和 / 标准 / 绚丽，存于 localStorage `archipelago.fx`）。用户反馈过光效晃眼，调参时偏保守。

## 部署

- 线上地址：`https://isle.ai-news.top/`；审核台 `https://isle.ai-news.top/admin/`；投稿页 `https://isle.ai-news.top/submit`
- 服务器：`root@101.132.237.21`（Alibaba Cloud Linux 3，Docker 26 + Compose v2），已配置本机 `~/.ssh/id_ed25519` 免密登录
- 代码目录：`/opt/app-archipelago`（从 GitHub `cnwinds/app-archipelago` 克隆）
- 三个容器，同一个 `docker-compose.yml`：
  - `app-archipelago`（web）：Nginx，托管站点、投稿页、审核台，只绑定 `127.0.0.1:5320`
  - `app-archipelago-api`：收录服务，不发布端口，内存上限 256 MB
  - `app-archipelago-worker`：Chromium + 出站代理，内存上限 1200 MB（不使用 swap）、1.5 核、只读根文件系统、去掉全部 Linux capability
- 数据：`/opt/app-archipelago/data/`（属主 uid 1000）。`app.db` 是唯一真源；`shots/` 是全部候选的原始截图（不对外）；`public/catalog/` 是 nginx 对外提供的 `published.json` 和已发布作品的封面；`backups/` 是每晚备份。这里的内容不入库，要备份就把 `backups/` 拉回本机
- `/opt/app-archipelago/.env`（不入库，样例见 `.env.example`）：`NPM_REGISTRY`（国内 npm 镜像）、`APK_MIRROR`（国内 Alpine 镜像）、`WORKER_TOKEN`、`LLM_*`、`NOTIFY_*`
- 审核台口令：`/opt/app-archipelago/secrets/admin.htpasswd`（不入库）。口令在首次运行 `scripts/server-init.sh` 时生成，只显示一次；忘了就删掉这个文件再运行一次脚本，会生成并显示新口令；因为这个文件是单文件挂载进容器的，换文件后要 `docker compose up -d --force-recreate web` 才生效
- Docker 镜像加速已在服务器 `/etc/docker/daemon.json` 配置

更新上线（先把代码推到 GitHub）：

```powershell
ssh root@101.132.237.21 'cd /opt/app-archipelago && git pull && docker compose up -d --build'
```

首次部署或换新服务器：先 `sh scripts/server-init.sh`，再运行上面的命令。要开启或更换 AI 起草：在服务器 `.env` 里填 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（`.env` 权限 600），然后 `docker compose up -d api`（api 启动日志里会显示 `ai <模型名>` 或 `ai off`）。换模型前先用 `docker exec` 在 api 容器里调一次 `createLlm(...).draft(...)`，看是否被截断、是否支持 `response_format: json_object`。

服务器很小且共享：2 核、3.5 GB 内存、磁盘已用近 9 成，还跑着十几个其他服务。不要调高 worker 的并发和内存上限；清理 Docker 构建缓存（`docker builder prune`）前先问用户，它会影响同机其他项目的构建速度。

### 前端代理（Caddy）

- 服务器 80/443 由 Caddy 统一占用，配置在 `/etc/caddy/Caddyfile`，按 `*.ai-news.top` 子域名反代到各服务的本机端口，自动申请 HTTPS 证书
- 本项目的规则：`isle.ai-news.top { encode zstd gzip; reverse_proxy 127.0.0.1:5320 }`。口令保护和路由都在项目自己的 `nginx.conf` 里，Caddy 不需要为收录服务改动
- 改 Caddyfile 前先备份（惯例命名 `Caddyfile.bak.<项目>-<时间>`），用 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 校验通过后再 `systemctl reload caddy`。机器上还有十几个其他站点，不要重启 Caddy
- 新增服务时选一个未占用端口并只绑定 `127.0.0.1`，先用 `ss -ltn` 检查
- 服务器上已有 Pocket ID 和 oauth2-proxy（`pan-shelf` 在用）。以后审核台想换成单点登录，只需把 `nginx.conf` 里的 `auth_basic` 换成 `auth_request`，应用本身不用改

### DNS

- `ai-news.top` 托管在 DNSPod（腾讯云），没有泛解析，每个新子域名都要在 DNSPod 手动加 A 记录指向 `101.132.237.21`
- 服务器上的 `aliyun` 命令行管不了这个域名的 DNS

## Windows 本机环境注意事项

- 本机 shell 是 Windows PowerShell 5.1：
  - 传给 ssh 的远程命令，最外层用**单引号**，里面要用的单引号写成两个（`''`），尽量不出现双引号：PowerShell 5.1 会把参数里的双引号吞掉。必须有双引号时（比如 JSON 请求体）写成 `\"`。`$var` 在单引号里不会被本机展开，可以直接写。再复杂的命令写成 `.sh` 文件，`scp` 到服务器后执行
  - 本地写出的脚本是 CRLF 换行，执行前用 `sed -i 's/\r$//' file` 转换
- 不要用 `Get-Content xxx.pub | ssh ...` 往服务器写 `authorized_keys`：PowerShell 管道会加 UTF-8 BOM 和 CRLF，导致密钥失效
- `~/.ssh/config` 曾因继承了一个已删除账户的写权限，被 OpenSSH 拒绝读取（已修复）。如果再出现 `Bad owner or permissions`，检查 `icacls`，用 `GetAccessControl('Access')` / `SetAccessControl` 删除对应 ACE（`Set-Acl` 会因缺少 SeSecurityPrivilege 失败）
- 本机没有 `gh` 和 `winget`；GitHub 推送走 SSH（账号 `cnwinds`）
- 本机 DNS 查询会拿到代理的 `198.18.x.x` 假 IP：验证解析要到服务器上执行 `getent ahostsv4 <域名>`；本机 `curl` 访问线上域名会报 SSL 错误（退出码 35），验证线上接口要在服务器上 `curl`，验证页面用本机 Chrome（puppeteer）
