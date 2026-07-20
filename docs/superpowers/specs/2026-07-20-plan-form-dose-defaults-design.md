# 用药计划表单对齐用药记录表单的剂量默认值与档位提示（2026-07-20）

## 背景（为什么改）

「新建用药计划」弹窗（PlanEditModal）和「新建用药记录」弹窗（DoseFormModal）在「(给药方式, 药物)」选项上本来是共用同一份底层清单（`ROUTE_DISPLAY_ORDER` + `getAvailableEsters(route)`，在 `utils/doseForm.ts`），但选完之后两份弹窗就岔开了：用药记录弹窗有档位按钮 + 剂量参考档位徽章 + 上次用药记忆 + 凝胶记忆，用药计划弹窗只能手填数字、默认永远是 5 mg、没参考档位提示、没上次记忆。

用户原话：「很多药物都需要自己自定义手动填写剂量，没有像用药记录中填写时一样的预设值选项」。

## 目标（一句话）

「新建用药计划」选完 (给药方式, 药物) 后呈现的按钮 / 默认值 / 颜色徽章 / 上次记忆，与「新建用药记录」**100% 一致**。

## 不做什么

- 不搬舌下详细字段（slTier / useCustomTheta / customTheta）到 PlanEditModal —— 计划生成的 record 由 DoseFormModal 自己处理 sublingual extras
- 不改 `DEFAULT_SCHEDULE`（按 (route, ester) 区分排期）—— 用户没问
- PlanEditModal 的"上次用药记忆"只**读** `readLastDrug`（决定默认打开 (route, ester)），**不写** `writeDoseMemo`（计划不是真实用药记录，避免污染）
- PlanEditModal 的"上次凝胶"接 `readLastGelEvent(events)`，同样只读不写

## 方案（用户已批准，全部一起做）

### 第一波（核心）

1. **剂量档位按钮** — 用现有 `QuickDosePanel` 组件替换 PlanEditModal 当前简单的 `<input>`，分支条件 `hasQuickDosePanel(route, ester)`
2. **按 (route, ester) 自动默认剂量** — 在 `utils/doseForm.ts` 加 `DEFAULT_DOSE_MAP`，新计划首次选某组合时落到推荐值；上次已有 per-drug memo 的优先用 memo（DoseFormModal 已经写过 `hrt-dose-by-drug`）
3. **剂量参考档位徽章** — 把 DoseFormModal 顶部硬编码的 `DOSE_GUIDE_CONFIG` / `LEVEL_BADGE_STYLES` / `LEVEL_CONTAINER_STYLES` / `formatGuideNumber` 全部提到 `utils/doseForm.ts`，并在 PlanEditModal 渲染同款卡片

### 第二波（顺手做）

4. **`readLastDrug` 初始化** — PlanEditModal 新建计划时，初始 (route, ester) 按 `readLastDrug()`，与 DoseFormModal 一致
5. **`readLastGelEvent` 凝胶预填** — PlanEditModal 新建计划时，凝胶字段（产品 / 部位 / 面积 / 清洗 / 共用产品 / 涂抹范围模板）从最近一次凝胶记录预填

### 默认剂量规则（用户拍板）

- **优先** 用 DoseFormModal 已写的 per-drug memo（`readDoseByDrug()[drugKeyOf(route,ester)].rawDose`）
- **回退** 用 `DEFAULT_DOSE_MAP[drugKeyOf(route,ester)]`（医学推荐默认，下面给出表格）
- **再次回退** 当 (route, ester) 不在 DOSE_GUIDE_CONFIG / DOSE_QUICK_PRESETS 里时，给 `''`（空，让用户手填）
- **切换 route / ester 触发重置**（用 `useEffect` 监听 drugKeyOf 变化）

### `DEFAULT_DOSE_MAP` 推荐值（中等等级，剂量单位与该 route 一致）

| 给药方式 + 药物 | 默认剂量 | 来源 |
|---|---|---|
| 舌下 E2 | 2 mg | cheatsheet 中等档位 1–2 mg |
| 舌下 EV | 2 mg | 同上 |
| 口服 E2 | 4 mg | cheatsheet 4–8 mg 取中 |
| 口服 EV | 4 mg | 同上 |
| 口服 CPA | 12.5 mg | 跨性别标准上限 |
| 口服 BICA | 50 mg | 标准剂量 |
| 肌注 EB/EV/EC/EN/EU | 5 mg | 保持现状（EV 5 mg/5d 是当前 PlanEditModal 硬编码值） |
| 肌注 PROG | 50 mg | 25/50/75 档位取中 |
| 直肠 PROG | 100 mg | 50/100/150/200 档位取中 |
| 贴片 E2 (rate) | 100 μg/天 | 100–200 取低 |
| 凝胶 E2 | 3 mg | cheatsheet 3–6 取低 |

## 文件改动清单

| 文件 | 操作 |
|---|---|
| `src/utils/doseForm.ts` | 新增 export：`DOSE_GUIDE_CONFIG` / `DoseGuideConfig` / `DoseLevelKey` / `LEVEL_BADGE_STYLES` / `LEVEL_CONTAINER_STYLES` / `formatGuideNumber` / `computeDoseGuide()` / `DEFAULT_DOSE_MAP` |
| `src/components/DoseFormModal.tsx` | 删除顶部硬编码常量，改成从 `doseForm` import；其它逻辑不变 |
| `src/components/PlanEditModal.tsx` | 改造：导入新共享常量；新建时 `readLastDrug()` 取默认；route/ester 切换 effect 重置默认 dose；用 QuickDosePanel 替换 input；渲染 doseGuide 卡片；gel 字段接 `readLastGelEvent(events)` |
| `src/utils/doseForm.test.ts` | 新建：覆盖 `DEFAULT_DOSE_MAP` lookup、`computeDoseGuide` 各档位边界（low / medium / high / very_high / above）、`formatGuideNumber`（整数 / 小数去尾） |

## 验证清单

- [ ] `npx tsc --noEmit` 通过
- [ ] `npm run test` 通过（新增 ~15 个 doseForm.test 用例）
- [ ] `npm run build` 通过
- [ ] 手动跑 dev server 验证：打开「新建用药记录」选黄体酮直肠，看到 [50][100][150][200] 按钮 + 彩色档位徽章；同样在「新建用药计划」选黄体酮直肠，选项完全一致
- [ ] 切换 route：打开新计划默认在上次用的 (route, ester)；切到凝胶预填上次凝胶细节
- [ ] 切到贴片释放速率模式，剂量参考档位正确显示（贴片需要先填释放速率）

## 风险与边界

- **i18n 键**：`dose.guide.*` / `dose.quick.custom` 都已存在中英两版，无需新增
- **类型兼容**：`DoseGuideConfig` 与 `computeDoseGuide` 返回值类型要保持和 DoseFormModal 现有一致，避免破坏 `doseGuide.level` / `doseGuide.showRateHint` 等处窄化类型
- **per-drug memo 只读不写**：避免计划 form 一打开就污染 `hrt-dose-by-drug`
- **`patchMode='rate'` 不暴露 doseGuide**：与 DoseFormModal 一致，贴片在 dose 模式下提示用户切到 rate 模式
- **不破坏已有 PlanEditModal 行为**：所有现有字段（schedule、weekdays、times、startDate、endDate、leadMinutes、enabled、compliance preview、conflict confirm、patch mode toggle、gel fields）继续工作