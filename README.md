# HRT Tracker

HRT Tracker 是一个网页端的激素替代疗法（HRT）追踪工具。它根据体重、身高和给药方式模拟雌二醇浓度在体内的实时变化，并基于化验结果拟合个人代谢参数。数据全部保存在浏览器的 `localStorage` 中，不上传，不联网。

English version: [README.en.md](./README.en.md)

> 本仓库是 [TransmtfTeam/Transmtf-HRT-Tracker](https://github.com/TransmtfTeam/Transmtf-HRT-Tracker) 的 fork，仍按 MIT License 发布，详见 [`LICENSE`](./LICENSE)。原作者的版权声明保留在 LICENSE 文件中。

## 功能

- **多给药途径模拟**：注射（戊酸酯、苯甲酸酯、环戊丙酸酯、庚酸酯）、口服、舌下、凝胶、贴片。
- **实时血药浓度曲线**：交互式图表展示雌二醇浓度（pg/mL）随时间的变化。
- **舌下含服参考**：给出含服时长与吸收参数 θ 的具体建议值。
- **个人代谢参数拟合**：录入化验结果后，用贝叶斯 OU-Kalman 模型反推个人代谢节奏。
- **多语言界面**：简体中文、繁体中文、英语、粤语、俄语、乌克兰语等。
- **数据全本地**：所有记录存在浏览器 `localStorage`，刷新与离线场景下都能继续使用。
- **免责声明与 AI 咨询导出**：首次启动显示免责声明；设置页可按日期范围导出文本快照，便于咨询医师或 LLM。

## 上游算法

药代动力学公式与参数来自 [HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test) 仓库中的 `PKcore.swift` 与 `PKparameter.swift`。这部分逻辑在本 fork 中未做修改。

## 本地运行

```bash
npm install
npm run dev
```

桌面端与 Android 端的安装包在 GitHub Actions 上构建。`tauri:dev` 与 `tauri:build` 在本地需要 Rust 与 Android SDK。

## 部署

欢迎自行部署到个人网站、博客或服务器，无需额外授权。公开部署时请保留指向本仓库的链接与 MIT License（[`LICENSE`](./LICENSE)）。

## 反馈

请到本仓库的 GitHub issue 区提交反馈。
