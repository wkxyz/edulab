# pt.yokily.com 部署

目标地址：`https://pt.yokily.com`。服务运行在独立Linux主机，Cloudflare管理子域名解析，Caddy处理HTTPS，Node服务处理上传与任务，Chromium/ffmpeg渲染视频。保留原有 `yokily.com` 网站配置。

## 主机准备

建议4核8GB、80GB以上磁盘、Ubuntu 24.04或兼容Linux；先运行单实例。需要Docker Engine、Compose v2、Python3。专用主机放行80/443，8788只绑定回环地址。已有网站占用80/443时，须将Caddy站点配置合入现有反向代理，不能停掉或替换不相关服务。

```bash
git clone --branch codex/ai-video-website https://github.com/wkxyz/edulab.git
cd edulab
python3 deploy/tutor/prepare-env.py
docker compose -f compose.tutor.yml -f compose.tutor.public.yml config --quiet
docker compose -f compose.tutor.yml -f compose.tutor.public.yml build
docker compose -f compose.tutor.yml -f compose.tutor.public.yml up -d
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
docker compose -f compose.tutor.yml -f compose.tutor.public.yml exec tutor node control.mjs status
```

先验证手机/桌面首页、固定示例、取消、历史、刷新恢复和视频拖动。`liveEnabled:false` 表示真实服务关闭，这是默认状态。将现有KIE密钥写入服务器 `.env`，核对单价和单题预留值，设置明确日预算后再开启 `LIVE_ENABLED`；不得把密钥放入网页或提交仓库。

首次收费接口验证仅提交一题，检查答案、中文发音、视频效果及KIE实际消耗，再决定是否开放给其他用户。设备体验会话不等于正式账号，公开服务的隐私政策和访问控制仍须按实际使用范围配置。

## 停止、恢复与日志

```bash
docker compose -f compose.tutor.yml -f compose.tutor.public.yml exec tutor node control.mjs stop
docker compose -f compose.tutor.yml -f compose.tutor.public.yml exec tutor node control.mjs status
docker compose -f compose.tutor.yml -f compose.tutor.public.yml exec tutor node control.mjs resume
docker compose -f compose.tutor.yml -f compose.tutor.public.yml logs --tail=80 tutor caddy
```

停止状态、额度与请求计数存在数据卷，重启不清零；已经被KIE接受的任务可能继续收费。普通关闭服务也会进入暂停状态，重新启动后需要明确恢复。不要使用删除数据卷的命令来解决暂停或额度问题。

此文档与部署配置不代表已经上线。当前还需要确认可连接的主机、回读实际解析和公开HTTPS服务。
