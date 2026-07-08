# 添加黄体酮（PROG）模块设计

**日期**：2026-07-08
**状态**：已批准，待实施
**目标仓库**：`D:\database\GitHub\Transmtf-HRT-Tracker`

## 1. 用户视角变化（给用户看）

### 1.1 用药录入页
- 「给药途径」下拉多一项：**直肠**
- 选「直肠」后，「药物」下拉只有一项：**黄体酮（PROG）**
- 直肠档位按钮（点一下就填进剂量框）：`50 / 100 / 150 / 200 mg`
- 选「肌注」时，药物下拉里也加黄体酮，档位按钮：`25 / 50 / 75 mg`
- 录入框下面剂量参考等级的单位都显示成 **`mg/次`**（不写"每天"，黄体酮用法灵活——有的睡前吃直肠，有的肌注，不分昼夜）

### 1.2 用药计划页（建周期性方案）
- 跟录入页同步：给药途径下拉多「直肠」，药名下拉多「黄体酮」，档位按钮同步
- 冲突规则不变：同一个「黄体酮+直肠」不允许重复启用；但「黄体酮+直肠」和「黄体酮+肌注」互不冲突（允许都启用）

### 1.3 用药日历热力图
- 黄体酮的日子显示琥珀橙色（`#F59E0B`）—— 这是「孕激素」桶的预留色，之前已经定义好了，无需改
- 跟现有的 E2 红色、抗雄蓝色形成第三种色，互不影响

### 1.4 首页 Overview
- **不变**，保持两张侧卡（E2 + 抗雄）

### 1.5 翻译
- 4 语言（中文/英文/繁体/日语）都要加新词：黄体酮、直肠、mg/次

### 1.6 后台血药浓度曲线
- **不变**：黄体酮没有药代动力学模型，曲线里不出数据（和 CPA/BICA 一致——它们在曲线里也不单独画线）

## 2. 技术改动（仅回看不读）

### 2.1 types.ts
- `Ester.PROG = "PROG"`
- `Route.rectal = "rectal"`

### 2.2 planSchedule.ts
- `drugCategoryOf(Ester.PROG)` 返回 `'progestin'`
- 现有「PRL」「Progesterone」字符串 fallback 保留（向后兼容老 JSON）

### 2.3 doseForm.ts
- `ROUTE_DISPLAY_ORDER` 末尾追加 `Route.rectal`
- `getAvailableEsters`：
  - `Route.rectal` → `[Ester.PROG]`
  - `Route.injection` → 现有 5 种 + `Ester.PROG`
- `DOSE_QUICK_PRESETS` **重构**为 `Partial<Record<`${Route}:${Ester}`, number[]>>`：
  - `'rectal:PROG'` → `[50, 100, 150, 200]`
  - `'injection:PROG'` → `[25, 50, 75]`
  - 现有 8 个键同步迁移（如 `'sublingual:EV'`、`'oral:CPA'` 等）
- `DOSE_GUIDE_CONFIG` 同样重构：
  - `'rectal:PROG'` → `{ unitKey: 'mg_dose', thresholds: [50, 100, 150, 200] }`
  - `'injection:PROG'` → `{ unitKey: 'mg_dose', thresholds: [12.5, 25, 50, 75] }`
  - 现有 5 个键同步迁移
- `hasQuickDosePanel` 简化为 `!!DOSE_QUICK_PRESETS[`${route}:${ester}`]`

### 2.4 i18n（4 语言）
- `ester.PROG` = `黄体酮` / `Progesterone` / `黃體酮` / `プロゲステロン`
- `route.rectal` = `直肠` / `Rectal` / `直腸` / `直腸`
- `plan.route.rectal` = 同上
- `field.mg_dose` = `mg/次` / `mg/dose` / `mg/次` / `mg/回`

### 2.5 测试
- `planSchedule.test.ts`：加 `expect(drugCategoryOf(Ester.PROG)).toBe('progestin')`
- `heatmapData.test.ts`：加 `expect(heatmapColorForEster(Ester.PROG)).toBe('#F59E0B')`

### 2.6 不动的部分
- 首页 OverviewView（不加第三张侧卡）
- planCompliance / planReminder / sanitizePlansForConflict（自动通过 `drugCategoryOf` 生效）
- pk.ts 仿真层（黄体酮无 PK 模型）

## 3. 风险点
1. `DOSE_QUICK_PRESETS` / `DOSE_GUIDE_CONFIG` 重构会波及多个引用点——按计划逐个迁移保证现有行为不变
2. 旧数据兼容：现有 fallback 字符串处理保留（旧 `'PRL'` / `'Progesterone'` 仍映射到 `progestin`）
3. `DoseFormModal.tsx` 中读取 `DOSE_GUIDE_CONFIG[route]` 的所有地方需同步改成 `[`${route}:${ester}`]`

## 4. 实施顺序
1. types.ts 加 `Ester.PROG` + `Route.rectal`
2. planSchedule.ts 加 `drugCategoryOf` case + 单测
3. doseForm.ts 重构两个 map + 加 rectal + PROG 档位
4. DoseFormModal.tsx 适配 key shape
5. i18n 4 语言补 key（`ester.PROG`、`route.rectal`、`plan.route.rectal`、`field.mg_dose`）
6. heatmapData.test.ts 加 PROG 颜色断言
7. tsc + vitest 全验证
8. 按主题拆 commit（建议：types → logic → doseForm 重构 → DoseFormModal 适配 → i18n → 测试 → 验证）

## 5. 验证
- vitest 263+ 条全过，新加的 2 条都过
- tsc 无新增错误（`src-tauri/target/` 的 Rust codegen 噪音仍存在但与本次无关）
- 不主动截图（按用户偏好）
- 不引入新的依赖
