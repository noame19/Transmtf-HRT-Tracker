# HRT Tracker

HRT Tracker is a web tool for tracking hormone replacement therapy. It simulates estradiol and other hormones' plasma concentration over time from body weight, height, and dosing route, and fits per-user metabolic parameters from lab results. All data lives in the browser's `localStorage` — nothing is uploaded without explicit opt-in, and the app stays usable offline. An optional cloud sync uploads end-to-end encrypted data to the companion server.

Chinese version: [README.md](./README.md)

> This repository is a fork of [TransmtfTeam/Transmtf-HRT-Tracker](https://github.com/TransmtfTeam/Transmtf-HRT-Tracker), still under the MIT License (see [`LICENSE`](./LICENSE)). The original copyright notice is preserved in that file.

## Dosing routes

- **Injection (IM)**: estradiol valerate (EV), estradiol benzoate (EB), estradiol cypionate (EC), estradiol enanthate (EN), estradiol undecylate (EU, long-chain), progesterone.
- **Oral**: estradiol (E2), estradiol valerate (EV), cyproterone acetate (CPA), bicalutamide.
- **Sublingual**: estradiol (E2), estradiol valerate (EV). Four preset hold / absorption tiers — quick, casual, standard, strict — plus a custom θ.
- **Transdermal gel**: five presets (Oestrogel, Estreva, EstroGel, Divigel, DIY). Application sites cover arm, thigh, scrotal, abdomen. Wash-off time and sunscreen / moisturizer co-application are recorded.
- **Transdermal patch**: linked apply + remove events share a `companionGroupId`; the engine reads the wear window from that pair.
- **Rectal (suppository)**: bedtime progesterone.

## Concentration curve and personal fitting

- **E2 (pg/mL) curve**: total concentration from body weight, height, route, and event time. The E2 family (E2 / EB / EV / EC / EN / EU) is kept separate from anti-androgens (CPA / bicalutamide).
- **Lab-based personal fit**: ingest lab values and infer the user's metabolism from the population prior. Lab units: `pg/mL` or `pmol/L`.
- **Three calibration models**: EKF, Ornstein–Uhlenbeck Kalman (with optional RTS smoothing), and Hybrid-MIPD (MAP + Student-t robust likelihood + Laplace covariance + GP residual correction). Temporal mode toggles between causal (new data never rewrites the past) and retrospective.
- **Confidence bands**: when a personal model exists, 95% CI and 68% CI both render under the curve; the E2 card also overlays Raw / Baseline / Personal values.
- **Endogenous baseline**: pre-dose labs become an endogenous estradiol baseline added on top of the curve.
- **CPA → E2 inhibition**: optional toggle applies a Hill-equation CPA inhibition of E2 clearance to both the central line and the confidence bands.

## Dosing plans

- **Three schedule kinds**: daily, every N days, weekly (multi-select weekdays). Multiple dose times per plan are supported.
- **Next-due preview**: each drug card on the home page shows the next plan + a large clock + relative-day label + last dose.
- **Reminder lead time**: 0–30 minutes, wired into the Android notification channel.

## Reminders and compliance

- **On-time reminders**: with notification permission, Android surfaces a system notification; tapping it confirms in one tap.
- **Late state**: past `due + 1h` the banner switches to "已过服药时间"; auto-dismiss 4h after the due moment.
- **Delay and skip**: from the banner, delay 1 day, delay 2 days, or skip the current plan.
- **Compliance banner**: when a drug category (estrogen / anti-androgen / progestin) has both an enabled plan and enough recent history but the dominant (ester, route) disagrees, a top banner lists the latest 4 samples.

## History and operations

- **History page**: grouped by local calendar date; long-press enters multi-select with bulk delete; patch applications show a one-tap "贴片移除" button that adds the paired remove.
- **Batch entry**: same regimen for several days in one go, with per-row confirmation.
- **Heatmap**: a calendar coloured by drug category; multi-day patches render as one continuous segment; today is outlined.
- **Plan page**: enable / disable, edit, delete; one active plan per drug category at a time.

## Export and backup

- **AI-consultation export**: a date-range markdown snapshot — profile + active plans + dose log + lab results + 90-day achievement rate + monthly postpone count — with an instruction for the LLM to reply in the user's current UI language.
- **Encrypted export**: full backup encrypted with AES-GCM using a PBKDF2 (100k) key derived from a randomly generated password that only the exporter sees.
- **JSON import**: v2 / v3 / v4 schemas; imports reconcile patch pairings and orphan events automatically.
- **Auto-backup**: a silent snapshot lands under `Downloads/HRT Tracker/` before any destructive action (import, clear); a 180-day rolling sweep keeps only the recent ones.

## Cloud sync and account (optional)

- **Account**: username + password with Cloudflare Turnstile; optional OIDC binding to an external identity provider.
- **End-to-end encrypted sync**: local data is encrypted with the security password before upload; the app still works fully offline.
- **Device list**: view and sign out bound devices on the account page.
- **Security password**: a cookie-based auto-unlock; expiry prompts for re-entry.

## Privacy and presentation

- **First-launch disclaimer**: shown once on first launch; revisit anytime from Settings.
- **Theme colour / dark mode**: Sakura preset and others; glass-morphism styling (frosted-glass cards).
- **Share image**: render the current concentration chart to PNG in one tap.
- **Public stats**: a small panel in Settings shows total users, last-7-day syncs, database size, and last update timestamp.
- **Basic info**: HRT start date, allergies / contraindications, birth year-month.

## Languages

Simplified Chinese, Traditional Chinese, English, Japanese.

## Packaging and deployment

Desktop and Android installers build via GitHub Actions. `tauri:dev` and `tauri:build` on a local machine require Rust and the Android SDK. The web bundle is plain static assets and can be self-hosted anywhere; for public deployments, please keep a link back to this repository and the MIT License.

## Run locally

```bash
npm install
npm run dev
```

## Upstream algorithm

The pharmacokinetic formulas and parameters are derived from the [HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test) repository (`PKcore.swift`, `PKparameter.swift`). This logic is unchanged in the fork.

## Feedback

Open an issue on the GitHub repository page.