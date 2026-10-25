# 小y主机

用户于2026-10-24将这台腾讯云主机命名为「小y」。它是题解网站的服务器：

- 公网地址：43.173.94.201；SSH端口22；用户root。
- 网站：https://pt.yokily.com；代码目录：/opt/edulab。
- 代码仓库：wkxyz/edulab；部署分支：codex/ai-video-website。
- 用户Mac已有id_ed25519及已验证的known_hosts记录。使用已有密钥，不将私钥或API Key写入仓库。
- 本地登录别名采用ASCII `xiaoy`，命令为 `ssh xiaoy`。`ops/xiaoy/setup-ssh.py` 在用户自己的终端安装别名；已有配置先备份，冲突时停止，严格验证主机身份，不启用密码登录。

别名安装不等于授予ChatGPT执行环境网络权限。当前会话若返回SSH `Operation not permitted`，应说明限制；不能通过改名、关闭主机验证、转存私钥、开放网站管理端口或绕过沙箱来解决。执行环境必须本身允许到该主机的SSH连接。

## 六模块上线状态

用户执行升级后，回读 `/tmp/edulab-upgrade-result.json`：状态upgraded，应用版本360ebf65b8147e256da62007464f80adc6758c5a，六类能力验证通过，原配置、额度、累计计数和停止状态保留，没有回退。升级提交生成任务0、付费生成调用0。

独立公网复核：首页HTTP200，标题「题解 · 数理化交互与视频讲解」；`/api/capabilities` HTTP200，返回六类模块。工具对公网健康接口的独立复查遇到响应读取中断；升级程序的健康回执为stopped=false、liveEnabled=false、liveLimitReached=true、sampleAvailable=true。不能把该读取中断解释为网站故障，也不据此声称独立健康复查通过。

真实题累计上限仍为2题且已用完。新增真实题额度、预算和付费测试须获得明确授权；免密登录与主机命名不改变此约束。
