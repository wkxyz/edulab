# 默认解答与按需配音 Implementation Plan

> **For agentic workers:** 按明确分工并行实施并集成验证；用户已授权开始推进，无需重复设计批准。

**Goal:** 六模块默认无配音讲解、点击配音、按需MP4，统一受2000分累计预算约束。
**Architecture:** Node/SQLite持久化阶段任务与预留，可信edulab引擎生成无声/有声HTML及MP4；来源ID由服务器检查，保留已核对答案。
**Tech Stack:** Node24、SQLite、Python/SymPy、原生网页、Playwright、ffmpeg。
**Spec:** ../specs/2026-10-25-lesson-first-budget-design.md

## Global Constraints

- 项目累计预留最大2000分，包含历史任务；不按日重置或自动释放失败占用。
- 开发和CI仅模拟供应商/离线样例，不调用付费API，不更改生产Key或停止状态。
- 最新main开新分支、PR及CI；只经main自动部署。

## Review Focus

- 重复点击及刷新不得重复付费；他人/未完成/过期来源必须拒绝。
- 跨日/重启的历史预留保留；旧输入缺少新字段仍保持幂等。
- 老视频可播放下载；无声讲解不能直接导出有声视频。
- 交互转配音不丢条件、不改答案、不接受模型可执行代码。
- 全六类输出须实际浏览器检查，不能以模拟通过冒充真实供应商效果。

### Task 1: 后端阶段任务与预算

Files: services/tutor/{service,server,store,config,validation}.mjs、.env.example及回归测试。
Interfaces: delivery=lesson|video，createNarration(id,owner)，POST /api/tasks/:id/narration，stages及budget健康数据。

- [ ] 新增默认无配音、来源归属、幂等、跨日/重启累计限额、失败占用保留、导出门槛检查。
- [ ] 实现原子预留、分阶段限额及旧记录兼容，运行后端检查。

### Task 2: 无声预览与复用配音

Files: runner.mjs、render.mjs、animated-video.mjs、新阶段辅助模块与检查。
Interfaces: format=lesson|interactive且audioReady=false；配音任务带narrationOf/sourceMode/sourceCapability/sourceResult；完成后audioReady=true/videoReady=false。

- [ ] 证明默认TTS和MP4为0。
- [ ] 实现无声可信预览、原lesson复用、交互讲解确定性配音板书。
- [ ] 验证原题答案不变、完整文字保留和导出不新增供应商调用。

### Task 3: 页面入口

Files: apps/web/*、前端回归检查。
- [ ] 默认提交delivery lesson，保留六类及全部图文输入。
- [ ] 分别显示生成配音和导出MP4按钮，跟随新任务ID，阻断重复点击。
- [ ] 验证阶段状态、预算提示、历史、公式与旧视频。

### Task 4: 集成与交付

Files: tutor-check.yml、smoke.mjs、kie-flow.mjs、capabilities-smoke.mjs、文档。
- [ ] 实际浏览器验证默认解答→配音→导出，保留原有模拟与容器回归，真实付费调用0。
- [ ] 创建main目标PR，写明自测和历史预算占满的限制。
- [ ] CI通过后核查自动部署；缺失时保留PR并返回链接供PO处理。
