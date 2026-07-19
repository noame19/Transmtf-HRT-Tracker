# CLAUDE.md

本仓库特定的开发指令与硬事实(global CLAUDE.md 之外补充)。

---

## 血药浓度图(ECharts)层结构

`src/components/ResultChart.tsx` 用 ECharts canvas 渲染,层结构如下。

### E2 曲线下方 3 层

显示条件:`hasPersonalModel`(E2 个性化模型存在)。

| 层 | 颜色 | 不透明度 | 渐变 |
|---|---|---|---|
| 曲线渐变填充 | `rgb(242,163,173)` = `#f2a3ad` | 顶部 **0.33** | 到底部 0(垂直渐变) |
| 95% CI band | `rgba(244,63,94)` 红 = `#f43f5e` | **0.24**(纯色) | — |
| 68% CI band | 同上红 | **0.32**(纯色) | — |

注意:E2 的 95%/68% CI band 颜色固定红,**不会跟着 E2 曲线颜色变**。

### CPA/BICA 曲线下方 2 层

显示条件:`hasPersonalCpaModel && hasPersonalCpaCI && hasCPADoses`(必须三个都满足)。

| 层 | 颜色 | 不透明度 | 渐变 |
|---|---|---|---|
| 曲线渐变填充 | `rgb(0,176,240)` = `#00b0f0` | 顶部 **0.25** | 到底部 0(垂直渐变) |
| 95% CI band | 同上青 | **0.25**(纯色) | — |

CPA 95% CI 与曲线填充同色同 alpha(都从 `aaBandFill(aaColor)` 出来),区别只在 CI band 不渐变到 0。**CPA 没有 68% CI 这一层**。

---

## 关键代码位置

- `src/components/ResultChart.theme.ts`:
  - `ECHART_THEME`:`e2Stroke`、`e2GradientTop/Bottom`、`ci95Fill`、`ci68Fill`、所有 `aaFallback` 之外的系列色常量都集中在这里。
  - `aaBandFill(aaColor)`:hex 转 rgba 的 helper,CPA 渐变填充顶部 + 95% CI 共用,当前 base alpha 0.25。
- `src/components/ResultChart.tsx`:option builder 在 ~line 1150-1350,层组装顺序 = CI band 先(在曲线下),主曲线最后(在 CI 之上)。
- `pk.ts:536-559`:`ANTIANDROGENS` 表,运行时给 CPA/BICA 选曲线主色(目前 `color: '#00b0f0'`)。