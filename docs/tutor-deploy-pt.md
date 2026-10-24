# pt.yokily.com 部署

目标地址：`https://pt.yokily.com`。服务运行在独立Linux主机，Cloudflare管理子域名解析，Caddy处理HTTPS，Node服务处理上传与任务，Chromium/ffmpeg渲染视频。保留原有 `yokily.com` 网站配置。

2026-10-24 17:47（北京时间）已部署MiniMax版本：`MiniMax-M3.1-Flash` 解题与 `speech-2.8-hd` 配音使用独立服务端密钥，服务器只读鉴权和公网健康检查通过。当前真实生成仍关闭，累计上限1题已由之前失败的KIE验收消耗；追加真实验收需要明确授权。固定示例可用，正式账号和收费尚未开放。详见 [最新部署记录](tutor-qa.md#minimax-服务器部署与密钥验收2026-10-24)。

## 主机准备

建议4核8GB、80GB以上磁盘、Ubuntu 24.04或兼容Linux；先运行单实例。需要Docker Engine、Compose v2、Python3。专用主机放行80/443，8788只绑定回环地址。已有网站占用80/443时，须将Caddy站点配置合入现有反向代理，不能停掉或替换不相关服务。

当前主机位于腾讯云硅谷，Ubuntu 24.04 x86_64、2核2GB、40GB磁盘，工作目录 `/opt/edulab`，保留主机已有约2GB交换空间。该规格已通过串行固定示例与模拟KIE流程；不代表复杂题目或并发负载已验证。下面命令叠加 `compose.tutor.host.yml`，限制题解容器为1200MB内存和1.5核，给系统及代理留出资源；较大主机可省略这一叠加文件。

```bash
git clone --branch codex/ai-video-website https://github.com/wkxyz/edulab.git
cd edulab
python3 deploy/tutor/prepare-env.py
docker compose -f compose.tutor.yml -f compose.tutor.public.yml -f compose.tutor.host.yml config --quiet
docker compose -f compose.tutor.yml -f compose.tutor.public.yml -f compose.tutor.host.yml build
docker compose -f compose.tutor.yml -f compose.tutor.public.yml -f compose.tutor.host.yml up -d
```

准备脚本仅在 `.env` 不存在时创建服务端配置，文件权限0600，并生成随机管理令牌；不输出令牌、不覆盖已有配置，真实KIE调用和预算默认关闭。以后维护始终使用同一工作目录和Compose项目名，保留 `tutor-data` 数据卷。

## 域名与证书

服务运行并完成本机检查后，在Cloudflare的 `yokily.com` 中新增名称为 `pt` 的A记录，指向已确认的主机公网IPv4；有可用IPv6时可另加AAAA。已有同名记录时先核对目标，不能直接覆盖。

初次申请Caddy公开证书时使用仅DNS解析，让80/443直接到达主机。回读DNS并访问 `https://pt.yokily.com`，证书与服务正常后再按需要启用Cloudflare代理，SSL/TLS模式使用Full (strict)。不要使用Flexible。不要把A记录指向Cloudflare边缘IP、占位IP或不运行该服务的主站。

`compose.tutor.public.yml` 只增加Caddy与证书卷。站点默认只响应 `pt.yokily.com`；公网 `/api/admin/*` 返回404，操作管理通过容器内部命令执行。

## 验收与启用

```bash
curl --fail --retry 20 --retry-delay 1 --retry-all-errors --retry-max-time 30 --max-time 3 http://127.0.0.1:8788/api/health
curl --fail https://pt.yokily.com/api/health
docker compose -f compose.tutor.yml -f compose.tutor.public.yml -f compose.tutor.host.yml exec tutor node control.mjs status
```

先验证手机/桌面首页、固定示例、取消、历史、刷新恢复和视频拖动。`liveEnabled:false` 表示真实服务关闭，这是默认状态。将现有KIE密钥写入服务器 `.env`，核对单价和单题预留值，设置明确日预算后再开启 `LIVE_ENABLED`；不得把密钥放入网页或提交仓库。

首次收费接口验证仅提交一题，检查答案、中文发音、视频效果及KIE实际消耗，再决定是否开放给其他用户。设备体验会话不等于正式账号，公开服务的隐私政策和访问控制仍须按实际使用范围配置。

### 使用 MiniMax-M3.1-Flash 解题

用户指定MiniMax后，设置 `AI_PROVIDER=minimax`、`MINIMAX_REGION=cn`（国内平台）或 `global`（国际平台），将对应平台的解题密钥写入 `MINIMAX_API_KEY`。模型固定为 `MiniMax-M3.1-Flash`，思考深度默认 `medium`；使用官方 `/v1/chat/completions`，开启 `reasoning_split`，只消费最终讲解内容，求解和复核分别最多8192/4096生成tokens。图片通过Base64直接传给MiniMax，不再上传至KIE文件服务。

配音默认改为MiniMax `speech-2.8-hd`，普通话成熟女声 `female-chengshu`。使用 `MINIMAX_TTS_API_KEY` 单独配置配音Key；缺省时复用MiniMax解题Key。配音平台区域可通过 `MINIMAX_TTS_REGION=cn|global` 单独指定，确保与Key来源一致。每段通过同步接口直接返回WAV，不轮询、不下载供应商提供的外部URL。需要旧通道时显式设置 `TTS_PROVIDER=kie|glm`；任何通道均不会转发另一家的密钥。密钥未配置时不允许真实任务。

M Plan订阅Key可用于受限的个人交互式验收，正式对外运行建议使用普通按量计费API Key；两类Key的额度来源不同，不自动购买套餐或充值。已有失败任务、预算预留和累计次数必须保留；允许再做一题时显式增加累计上限，不清库、不自动重试。

官方依据：[MiniMax模型接口](https://platform.minimax.cn/docs/api-reference/text-chat-openai)、[官方定价](https://platform.minimax.cn/docs/pricing/overview)。截至2026-10-24，KIE模型市场搜索MiniMax仅列出H3视频模型，因此M3.1-Flash使用MiniMax官方通道。

### 首题验收的累计上限

配置 `LIVE_TASK_LIMIT=1` 可将整个项目累计受理的真实题限制为1道；统计来自已有SQLite任务，失败、取消、跨设备、跨天及重启均不恢复次数，固定示例不占此次数。到达上限后拒绝新的真实任务，不自动补充额度。`0` 阻止新真实任务；新生成的 `.env` 默认写入0。为兼容旧配置，未指定时为200，已有服务器须明确写入验收上限。

该限制是受理次数限制，不取消已经受理的任务。切换配置前先检查运行/排队任务，必要时使用 `control.mjs stop`。不能删除任务或数据卷来恢复次数。真实验收通过后，另行确认长期额度再调整上限。

单题沿用5分钟截止时间、最多2次解题/复核和12次配音生成、最多171次外部请求、串行处理及不自动重试。配音文本最多12段、每段160字。日预算和单题预算是人民币分的保守预留，不是KIE账户实际扣费的硬封顶；启用前核对当前单价和人民币换算。密钥只写服务器 `.env`，不写入网页、仓库、报告或日志。

## 停止、恢复与日志

```bash
docker compose -f compose.tutor.yml -f compose.tutor.public.yml -f compose.tutor.host.yml exec tutor node control.mjs stop
docker compose -f compose.tutor.yml -f compose.tutor.public.yml -f compose.tutor.host.yml exec tutor node control.mjs status
docker compose -f compose.tutor.yml -f compose.tutor.public.yml -f compose.tutor.host.yml exec tutor node control.mjs resume
docker compose -f compose.tutor.yml -f compose.tutor.public.yml -f compose.tutor.host.yml logs --tail=80 tutor caddy
```

停止状态、额度与请求计数存在数据卷，重启不清零；已经被KIE接受的任务可能继续收费。普通关闭服务也会进入暂停状态，重新启动后需要明确恢复。不要使用删除数据卷的命令来解决暂停或额度问题。

当前容器保留 `restart: "no"`，主机或Docker重启后需执行上面的 `up -d`，检查停止状态，再按需明确恢复；不能假设服务会自行重启。网站运行不依赖本机浏览器或OrcaTerm持续连接。
