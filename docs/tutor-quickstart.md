# 题解网站开发与部署说明

## 当前范围

原始 edulab 技能保持不变。新增 `services/tutor` 服务和 `apps/web` 响应式网站，手机与电脑共用一个入口。网站为原生 HTML/CSS/JavaScript，无需单独前端编译。

第一版接入的是声明式文字板书：自动题解、独立复核、分步讲稿、中文配音和 MP4。为避免执行模型生成代码，公开接口暂不接收任意 JS/HTML、函数表达式或几何动画脚本。学段不锁定；复杂图形题、语文英语等尚未完成质量验证。

`体验示例讲解` 固定讲解 `2x + 3 = 11`，用本机离线语音，不进行拍题识别，不调用付费 API。未配置真实服务时，上传题目返回明确错误，绝不套用示例结果。

## 开发服务

需要 Node.js 24、ffmpeg/ffprobe、Chromium。Linux 离线示例另需 `espeak-ng` 和中文字体；macOS 使用系统 `say` 的 Tingting 音色。

```bash
cd services/tutor
npm install --ignore-scripts --no-audit --no-fund
npx playwright install --with-deps chromium
cp .env.example .env
node --disable-warning=ExperimentalWarning --env-file=.env server.mjs
```

浏览器打开 `http://127.0.0.1:8788`。默认只监听本机，不公开部署。真实服务需要配置 `AI_BASE_URL`（HTTPS 的 OpenAI-compatible `/v1` 地址）、`AI_MODEL`、`AI_API_KEY`、`GLM_API_KEY`，确认单价后设置预算与 `LIVE_ENABLED=true`。所有密钥仅放服务端 `.env`，不得提交仓库或进入网页。

## 网站入口

服务直接提供首页、上传、任务进度、视频结果、历史记录和个人页。`#task/<任务ID>` 支持刷新后回到任务；浏览器后退/前进可切换页面。所有请求走同源 `/api/`，无需另开前端服务。

当前为浏览器设备体验会话，历史任务归当前浏览器令牌所有。没有跨设备账号和支付，清除浏览器数据会丢失访问会话。公开服务前应按实际范围补充账号/访问控制、隐私政策和保留期限。

## 云主机部署准备

推荐起步 4 核 8GB、80GB SSD、Ubuntu 24.04；先按并发 1 验证。服务器调用远程模型/配音接口，不需要本地运行大模型或购买 GPU。

```bash
cp services/tutor/.env.example services/tutor/.env
docker compose -f compose.tutor.yml build
docker compose -f compose.tutor.yml up
```

容器最多2核/3GB、进程256，端口只映射主机回环地址，使用持久卷保存任务/额度。公网发布需另行配置 HTTPS 反向代理、域名和访问控制；本说明不代表已发布。不可把数据库放临时容器文件系统。

在服务端 `.env` 设置至少32位随机 `ADMIN_TOKEN` 后，可在本机停止或恢复任务。未配置时管理接口不开放；不要把该令牌交给浏览器。

```bash
# 服务目录中操作；使用 Docker 时改为 docker compose -f compose.tutor.yml exec tutor node control.mjs stop
node --env-file=.env control.mjs stop
node --env-file=.env control.mjs status
node --env-file=.env control.mjs resume
```

停止会阻止提交、后续付费调用和队列调度，并中止当前渲染。已经送到供应商的请求可能已计费，取消不能追回费用。停止状态跨重启保存；正常关闭服务也会进入停止状态，再启动后须明确恢复。恢复不重新执行已取消或失败任务。单进程、单实例运行，不可让多个容器同时挂载同一数据库处理任务。

## 用量边界

每题最多2次模型请求（输出上限2400/640 token）、最多12段语音、最多14次外部调用；单段配音160字。任务300秒截止、无自动付费重试；串行处理；队列10、项目每天20题、每设备每天5题、项目最多200条任务。额度、调用预留和停止状态存在 SQLite，重启不重置。媒体与输入目前保存在持久卷，需按实际留存策略清理，不能无限保存。

预算以人民币分配置，为每题保守预留；需按照选择的模型和配音的实际单价核实预留值。应用内配额不等于云厂商账单硬封顶。主机、带宽、存储和供应商侧用量需分别核对。本轮自动化验证不调用真实模型/付费配音。

## 检查

```bash
npm test --prefix services/tutor
node --disable-warning=ExperimentalWarning services/tutor/scripts/smoke.mjs
```

GitHub Actions 在标准 Ubuntu runner 上检查 HTTP/额度行为、网页交互，生成离线带音轨视频并用浏览器播放。可复现的通过结果以对应开发分支 Actions 记录为准。Mac 沙箱禁止监听端口或启动 Chromium 时，不用权限绕过来伪造检查成功；改在授权的隔离云环境验证。
