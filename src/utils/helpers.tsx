import React from 'react';
import { Syringe, Pill, Droplet, Sticker, X } from 'lucide-react';
import { Route, DoseEvent, Ester, getBioavailabilityMultiplier, getToE2Factor, ExtraKey } from '../../logic';
import { Lang } from '../i18n/translations';

export const formatDate = (date: Date, lang: Lang) => {
    const locale = lang === 'zh' ? 'zh-CN' : (lang === 'zh-TW' ? 'zh-TW' : (lang === 'ja' ? 'ja-JP' : 'en-US'));
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
};

/** Date with year for the history timeline. The year is mandatory — without
 *  it, "2024年1月4日" and "2026年1月4日" look identical when scrolling. zh /
 *  zh-TW use the compact 年月日 form; en / ja use locale-native strings. */
export const formatDateWithYear = (date: Date, lang: Lang): string => {
    const locale = lang === 'zh' ? 'zh-CN' : (lang === 'zh-TW' ? 'zh-TW' : (lang === 'ja' ? 'ja-JP' : 'en-US'));
    return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
};

/** Sortable yyyy-mm-dd date key. Used as the timeline group key so 2024-01-04
 *  and 2026-01-04 form distinct groups (otherwise formatDate collapses them). */
export const dateKey = (date: Date): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

export const formatTime = (date: Date) => {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
};

/**
 * Full date+time for the patch-removed hint. Includes year so an apply/remove
 * pair that spans a year boundary is unambiguous (e.g. "2025-12-31 23:50" vs
 * "2026-01-01 00:10"). Local timezone — matches the rest of the app.
 */
export const formatDateTime = (date: Date, lang: Lang) => {
    const locale = lang === 'zh' ? 'zh-CN' : (lang === 'zh-TW' ? 'zh-TW' : (lang === 'ja' ? 'ja-JP' : 'en-US'));
    const datePart = date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
    const timePart = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${datePart} ${timePart}`;
};

export const getRouteIcon = (route: Route) => {
    switch (route) {
        case Route.injection: return <Syringe className="w-5 h-5 text-pink-400" />;
        case Route.oral: return <Pill className="w-5 h-5 text-blue-500" />;
        case Route.sublingual: return <Pill className="w-5 h-5 text-teal-500" />;
        case Route.gel: return <Droplet className="w-5 h-5 text-cyan-500" />;
        case Route.patchApply: return <Sticker className="w-5 h-5 text-orange-500" />;
        case Route.patchRemove: return <X className="w-5 h-5 text-gray-400" />;
    }
};

export const getBioDoseMG = (event: DoseEvent) => {
    const multiplier = getBioavailabilityMultiplier(event.route, event.ester, event.extras || {});
    return multiplier * event.doseMG;
};

export const getRawDoseMG = (event: DoseEvent) => {
    if (event.route === Route.patchRemove) return null;
    if (event.extras[ExtraKey.releaseRateUGPerDay]) return null;
    const factor = getToE2Factor(event.ester);
    if (!factor) return event.doseMG;
    return event.doseMG / factor;
};
