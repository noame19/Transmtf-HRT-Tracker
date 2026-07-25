# HRT Tracker

HRT 激素替代疗法追踪器的网页端。按体重、身高、给药方式模拟雌二醇浓度曲线，并保留所有数据在你浏览器的 localStorage 里不外发。 [TransmtfTeam/Transmtf-HRT-Tracker](https://github.com/TransmtfTeam/Transmtf-HRT-Tracker) 的 fork。English version: [README.en.md](./README.en.md)。

> 本仓库遵循 MIT License，参见 [`LICENSE`](./LICENSE)。代码与上游完全不同的地方都整理在本 README「本 fork 改了哪些东西」一节里。原作者的版权声明在 LICENSE 文件中保留。

## 项目是什么

一个用 React + TypeScript 写的网页 HRT 记录工具。输入吃药/打针/贴片/凝胶/舌下用药时间，工具会按药代动力学模型绘出雌二醇浓度随时间的变化曲线。你也可以录入化验结果，工具会用贝叶斯 OU-Kalman 模型反推你个人的代谢参数。数据全部存 `localStorage`，刷新或断网都不丢。

药代算法的原始公式与参数来自上游 [HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test) 仓库（`PKcore.swift` / `PKparameter.swift`）。这部分逻辑 fork 以后没有改。

## 本 fork 改了哪些东西

下面是 fork 在上游基础上做的用户可感知改动。每一条都对应到至少一个 fork-only commit，可以在 `git log main ^upstream/main` 里看到。

### 用户打开就能感觉到

- **免责声明**：第一次启动会弹一次免责声明。设置页可以再点开看。
- **一键导出咨询 AI**：设置页"数据管理"下多了一个入口，弹窗里选日期范围，点复制就能把个人记录带去问医生或 LLM。
- **AI 导出上下文更厚了**：导出文本里每条用药记录都附了当条的身高/体重、按给药方式区分的专属参数（舌下的 tier/θ、凝胶的 product/site/面积、贴片的撕下时间）、范围内事件数/总事件数。
- **OIDC 登录先不接**：上游的"用 Transmtf 账号登录"按钮目前点了会弹"等待开发中"。保留按钮，账号服务恢复再启用。
- **概况页手机端布局**：用药日历与血药浓度图位置对调，桌面图卡视觉位置不变。
- **批量添加重设计**：贴片路径删掉了"每日次数"字段，撕下提示补全日期，预览页 apply 时间不再卡 09:00，文案整体重写。
- **撕下按钮文案**：统一为「贴片摘下」。
- **设置/账户页署名链接**：全部指向本仓库维护者 noame19 的 GitHub。

### 修复与数据完整性

- **贴片配对不再 14 天时间轴兜底**：改严格 groupId 匹配，新建贴片统一分配 groupId，避免老数据被错配。
- **编辑老贴片显示"无配对撕下记录"**：避免编辑时静默删除撕下事件。
- **历史页空日期栏修复**：之前撕下事件单独撑出空日期栏的问题已处理。

### 构建与工程

- **Tailwind 不再走 Play CDN**：改成本地 PostCSS 编译。构建不再依赖外网。
- **Android 自动化构建**：`.github/workflows/` 加了安卓 debug/release 两条 workflow；本地不再编安卓，全走 CI。

## 本地运行

这是 React + TypeScript 项目，用 Vite 跑：

```bash
npm install
npm run dev
```

Tauri 桌面/安卓打包走 GitHub Actions 工作流。`tauri:dev` / `tauri:build` 在本机需要 Rust + Android SDK 才能跑。

## 部署与协议

欢迎自行部署到自己的个人网站、博客或服务器，不需要额外授权。如果你公开部署，请保留指向本仓库的地址与 MIT License（参见 [LICENSE](./LICENSE)）。

## 仓库点

遇到问题请在 GitHub 上提交 issue：<https://github.com/noame19/Transmtf-HRT-Tracker/issues>。
