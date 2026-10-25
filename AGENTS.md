# 网站开发约定

使用中文交流。pt.yokily.com的腾讯云主机43.173.94.201称为小y。

- 最新main开工作分支，修改后开PR说明改动与自测，CI通过后才能合并main；只由main自动部署，不手工发布。不能合并时返回PR链接给用户转PO；Grok Bot经PR merged事件通知PO。
- **自动部署**：`main` 推送/合入后由 GitHub Actions「Tutor deploy」（`.github/workflows/tutor-deploy.yml`）SSH 到小 y（`ubuntu@43.173.94.201`，无密码 sudo），在 `/opt/edulab` 检出该 commit，执行 `compose.tutor.yml` + `public` + `host` 的 build/up --force-recreate，再 `control resume`。也可在 Actions 页对「Tutor deploy」点 workflow_dispatch。失败看该 workflow 的 run 日志；成功后核对 https://pt.yokily.com/api/health（须含 `stages` + `budget`）。默认分支若仍是 `master`，部署仍只跟 `main`，不要跟 `master`。
- 本轮累计项目预算2000人民币分，包含所有历史任务reserve；不是每日20元或新增20元。预留不等于供应商实际账单，未核清费用前不退款/清零/释放历史预留。
- 开发和CI仅离线示例及模拟接口，不进行真实模型/TTS调用或充值。
- 保留密钥、历史、原题和已核对答案。默认无配音讲解；点击后配音，再按需导出MP4。重复操作必须幂等。
- 不提交真实.env、私钥、会话或媒体令牌。浏览器结束关闭助手页面，保留用户页面。
