import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import apiClient from '../api/client';
import { useAuth } from './AuthContext';
import { useSecurityPassword } from './SecurityPasswordContext';
import { computeDataHash } from '../utils/dataHash';
import { isLogoutInProgress } from '../utils/authSessionState';
import { isAuthExpiredResponse } from '../utils/authSession';
import type { ConflictState, FieldDiff } from '../components/SyncConflictModal';

interface CloudSyncContextType {
  isSyncing: boolean;
  lastSyncTime: Date | null;
  syncError: string | null;
  pendingConflict: ConflictState | null;
  resolveConflict: (resolution: 'local' | 'cloud' | 'merge', mergedData?: Record<string, any>) => void;
}

const CloudSyncContext = createContext<CloudSyncContextType | undefined>(undefined);

const LAST_SYNC_TIME_KEY = 'hrt-last-sync-time';
const LAST_PULL_TIME_KEY = 'hrt-last-pull-time';
const LAST_DATA_UPDATED_KEY = 'hrt-last-data-updated';
const SYNC_INTERVAL = 3000; // 3 seconds
const PULL_CHECK_INTERVAL = 3000; // 3 seconds

// Deep-equal for comparing field values (handles arrays, objects, primitives)
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v: any, i: number) => deepEqual(v, b[i]));
  }
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k, i) => keysB[i] === k && deepEqual(a[k], b[k]));
}

const SYNC_FIELDS = [
  'events', 'weight', 'labResults', 'lang',
  'calibrationModel', 'applyE2LearningToCPA',
  'applyCPAInhibitionToE2', 'themeColor', 'darkMode',
] as const;

function computeFieldDiffs(localData: Record<string, any>, cloudData: Record<string, any>): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of SYNC_FIELDS) {
    const localVal = localData[field];
    const cloudVal = cloudData[field];
    if (!deepEqual(localVal, cloudVal)) {
      diffs.push({ field, localValue: localVal, cloudValue: cloudVal });
    }
  }
  return diffs;
}

export const CloudSyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const { hasSecurityPassword, isVerified, securityPassword, passwordVerificationFailed } = useSecurityPassword();
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<ConflictState | null>(null);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isSyncingRef = useRef(false);
  const conflictPendingRef = useRef(false);

  // ── common guards ──
  const canSync = useCallback(() => {
    if (!isAuthenticated || isLogoutInProgress()) return false;
    if (hasSecurityPassword && !isVerified) return false;
    if (hasSecurityPassword && passwordVerificationFailed) return false;
    if (hasSecurityPassword && !securityPassword) return false;
    if (conflictPendingRef.current) return false;
    if (isSyncingRef.current) return false;
    return true;
  }, [isAuthenticated, hasSecurityPassword, isVerified, securityPassword, passwordVerificationFailed]);

  // ── getLocalDataSnapshot ──
  const getLocalDataSnapshot = useCallback(() => {
    const events = localStorage.getItem('hrt-events');
    const weight = localStorage.getItem('hrt-weight');
    const labResults = localStorage.getItem('hrt-lab-results');
    const lang = localStorage.getItem('hrt-lang');
    const calibrationModel = localStorage.getItem('hrt-calibration-model') || 'ekf';
    const applyE2Raw = localStorage.getItem('hrt-apply-e2-learning-to-cpa');
    const applyCPARaw = localStorage.getItem('hrt-apply-cpa-inhibition-to-e2');
    const themeColor = localStorage.getItem('hrt-theme-color') || 'sakura';
    const darkModeRaw = localStorage.getItem('hrt-dark-mode');

    const storedLastModified = localStorage.getItem('hrt-last-modified');
    const storedLastDataUpdated = localStorage.getItem(LAST_DATA_UPDATED_KEY);
    const parsedEvents = events ? JSON.parse(events) : [];
    const parsedWeight = weight ? parseFloat(weight) : 60;
    const parsedLabResults = labResults ? JSON.parse(labResults) : [];
    const resolvedLang = lang || 'en';
    const applyE2LearningToCPA = applyE2Raw === '1' || applyE2Raw?.toLowerCase() === 'true';
    const applyCPAInhibitionToE2 = applyCPARaw === '1' || applyCPARaw?.toLowerCase() === 'true';
    const darkMode = darkModeRaw === '1' || darkModeRaw === 'true';
    const dataHash = computeDataHash({
      events: parsedEvents,
      weight: parsedWeight,
      labResults: parsedLabResults,
      lang: resolvedLang,
      calibrationModel,
      applyE2LearningToCPA,
      applyCPAInhibitionToE2,
      themeColor,
      darkMode,
    });
    localStorage.setItem('hrt-data-hash', dataHash);

    return {
      events: parsedEvents,
      weight: parsedWeight,
      labResults: parsedLabResults,
      lang: resolvedLang,
      calibrationModel,
      applyE2LearningToCPA,
      applyCPAInhibitionToE2,
      themeColor,
      darkMode,
      lastModified: storedLastModified,
      lastDataUpdated: storedLastDataUpdated,
      dataHash,
    };
  }, []);

  // ── push (raw, no pull-check) ──
  const pushLocalDataToCloud = useCallback(async (localData: {
    events: any[];
    weight: number;
    labResults: any[];
    lang: string;
    calibrationModel?: string;
    applyE2LearningToCPA?: boolean;
    applyCPAInhibitionToE2?: boolean;
    themeColor?: string;
    darkMode?: boolean;
    lastModified: string;
    lastDataUpdated?: string | null;
  }) => {
    const response = await apiClient.updateUserData({
      data: {
        ...localData,
        lastDataUpdated: localData.lastDataUpdated || localData.lastModified,
      },
      password: hasSecurityPassword ? securityPassword : undefined,
    });

    if (response.success) {
      const now = new Date();
      const dataHash = computeDataHash({
        events: localData.events,
        weight: localData.weight,
        labResults: localData.labResults,
        lang: localData.lang,
        calibrationModel: localData.calibrationModel,
        applyE2LearningToCPA: localData.applyE2LearningToCPA,
        applyCPAInhibitionToE2: localData.applyCPAInhibitionToE2,
        themeColor: localData.themeColor,
        darkMode: localData.darkMode,
      });
      setLastSyncTime(now);
      localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
      localStorage.setItem('hrt-last-modified', localData.lastModified);
      localStorage.setItem('hrt-data-hash', dataHash);
      if (localData.lastDataUpdated) {
        localStorage.setItem(LAST_DATA_UPDATED_KEY, localData.lastDataUpdated);
      }
      return true;
    }

    if (isAuthExpiredResponse(response)) {
      return false;
    }

    setSyncError(response.error || 'Failed to sync to cloud');
    return false;
  }, [hasSecurityPassword, securityPassword]);

  const shouldPullFromCloud = useCallback(() => {
    const lastPull = localStorage.getItem(LAST_PULL_TIME_KEY);
    if (!lastPull) return true;
    return Date.now() - new Date(lastPull).getTime() >= SYNC_INTERVAL;
  }, []);

  // Load last sync time from localStorage
  useEffect(() => {
    if (isAuthenticated) {
      const lastSync = localStorage.getItem(LAST_SYNC_TIME_KEY);
      if (lastSync) setLastSyncTime(new Date(lastSync));
    } else {
      setLastSyncTime(null);
      setSyncError(null);
    }
  }, [isAuthenticated]);

  // ── apply cloud data to local ──
  const applyCloudToLocal = useCallback((data: any, localData: Record<string, any>, fallbackTimestamp?: string) => {
    const resolvedLang = data?.lang || localData.lang;
    if (data?.events) localStorage.setItem('hrt-events', JSON.stringify(data.events));
    if (data?.weight !== undefined) localStorage.setItem('hrt-weight', data.weight.toString());
    if (data?.labResults) localStorage.setItem('hrt-lab-results', JSON.stringify(data.labResults));
    if (data?.lang) localStorage.setItem('hrt-lang', data.lang);
    if (data?.calibrationModel) localStorage.setItem('hrt-calibration-model', data.calibrationModel);
    if (data?.applyE2LearningToCPA !== undefined) localStorage.setItem('hrt-apply-e2-learning-to-cpa', data.applyE2LearningToCPA ? '1' : '0');
    if (data?.applyCPAInhibitionToE2 !== undefined) localStorage.setItem('hrt-apply-cpa-inhibition-to-e2', data.applyCPAInhibitionToE2 ? '1' : '0');
    if (data?.themeColor) localStorage.setItem('hrt-theme-color', data.themeColor);
    if (data?.darkMode !== undefined) localStorage.setItem('hrt-dark-mode', data.darkMode ? '1' : '0');
    if (data?.lastModified || fallbackTimestamp) localStorage.setItem('hrt-last-modified', data?.lastModified || fallbackTimestamp || '');
    if (data?.lastDataUpdated || fallbackTimestamp) localStorage.setItem(LAST_DATA_UPDATED_KEY, data?.lastDataUpdated || fallbackTimestamp || '');
    const dataHash = computeDataHash({
      events: data?.events || [],
      weight: data?.weight ?? localData.weight,
      labResults: data?.labResults || [],
      lang: resolvedLang,
      calibrationModel: data?.calibrationModel || localData.calibrationModel,
      applyE2LearningToCPA: data?.applyE2LearningToCPA ?? localData.applyE2LearningToCPA,
      applyCPAInhibitionToE2: data?.applyCPAInhibitionToE2 ?? localData.applyCPAInhibitionToE2,
      themeColor: data?.themeColor || localData.themeColor,
      darkMode: data?.darkMode ?? localData.darkMode,
    });
    localStorage.setItem('hrt-data-hash', dataHash);
    window.dispatchEvent(new StorageEvent('storage', { key: 'hrt-data-synced', newValue: Date.now().toString() }));
  }, []);

  // ════════════════════════════════════════════════════════════
  //  UNIFIED SYNC — pull-before-push, conflict detection
  //  Called both by the 3-second poll AND by local-data-change.
  // ════════════════════════════════════════════════════════════
  const performSync = useCallback(async () => {
    if (!canSync()) return;

    isSyncingRef.current = true;
    setIsSyncing(true);
    setSyncError(null);

    try {
      // ① Pull cloud data
      const response = await apiClient.getUserData({
        password: hasSecurityPassword ? securityPassword : undefined,
      });

      const localData = getLocalDataSnapshot();
      const now = new Date();

      if (!response.success || !response.data) {
        if (isAuthExpiredResponse(response)) {
          return;
        }

        // Network / auth error — if we have local changes, still try to push
        if (localData.lastModified) {
          if (!(await pushLocalDataToCloud({ ...localData, lastModified: localData.lastModified }))) {
            return;
          }
        }
        return;
      }

      const cloudData = response.data.data;

      // ② No cloud data exists → push local
      if (!cloudData) {
        if (localData.lastModified) {
          if (!(await pushLocalDataToCloud({ ...localData, lastModified: localData.lastModified }))) {
            return;
          }
        }
        setLastSyncTime(now);
        localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
        localStorage.setItem(LAST_PULL_TIME_KEY, now.toISOString());
        return;
      }

      // ③ Compare hashes
      const cloudHash = computeDataHash({
        events: cloudData.events || [],
        weight: cloudData.weight ?? localData.weight,
        labResults: cloudData.labResults || [],
        lang: cloudData.lang || localData.lang,
        calibrationModel: cloudData.calibrationModel || '',
        applyE2LearningToCPA: cloudData.applyE2LearningToCPA ?? localData.applyE2LearningToCPA,
        applyCPAInhibitionToE2: cloudData.applyCPAInhibitionToE2 ?? localData.applyCPAInhibitionToE2,
        themeColor: cloudData.themeColor || localData.themeColor,
        darkMode: cloudData.darkMode ?? localData.darkMode,
      });

      if (cloudHash === localData.dataHash) {
        // Data identical — just sync the lastDataUpdated if missing
        if (!localData.lastDataUpdated && cloudData.lastDataUpdated) {
          localStorage.setItem(LAST_DATA_UPDATED_KEY, cloudData.lastDataUpdated);
        } else if (localData.lastDataUpdated && !cloudData.lastDataUpdated) {
          // Cloud lacks the field, push once so it's recorded
          if (!(await pushLocalDataToCloud({ ...localData, lastModified: localData.lastModified || now.toISOString() }))) {
            return;
          }
        }
        setLastSyncTime(now);
        localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
        localStorage.setItem(LAST_PULL_TIME_KEY, now.toISOString());
        return;
      }

      // ④ Data differs — try conflict detection via lastDataUpdated
      const cloudDataUpdated = cloudData.lastDataUpdated as string | undefined;
      const localDataUpdated = localData.lastDataUpdated as string | null;

      if (cloudDataUpdated && localDataUpdated) {
        const ct = new Date(cloudDataUpdated).getTime();
        const lt = new Date(localDataUpdated).getTime();

        if (ct !== lt) {
          // Both sides changed independently → conflict!
          const diffs = computeFieldDiffs(localData, cloudData);
          if (diffs.length > 0) {
            conflictPendingRef.current = true;
            setPendingConflict({
              localData,
              cloudData,
              diffs,
              localTime: localDataUpdated,
              cloudTime: cloudDataUpdated,
            });
            return; // wait for user resolution
          }
        }

        // Same lastDataUpdated but different hash is unlikely but possible
        // (e.g. settings changed by another mechanism).
        // Fall through to lastModified comparison below.
      }

      // ⑤ Fallback: compare lastModified (covers old data without lastDataUpdated)
      const cloudLM = cloudData.lastModified as string | undefined;
      const localLM = localData.lastModified;

      if (cloudLM && localLM) {
        if (new Date(localLM) > new Date(cloudLM)) {
          if (!(await pushLocalDataToCloud(localData))) {
            return;
          }
        } else {
          applyCloudToLocal(cloudData, localData);
        }
      } else if (!cloudLM && localLM) {
        if (!(await pushLocalDataToCloud({ ...localData, lastModified: localLM }))) {
          return;
        }
      } else if (cloudLM && !localLM) {
        applyCloudToLocal(cloudData, localData);
      } else {
        // Neither has timestamps — merge with fallback
        const fallback = now.toISOString();
        applyCloudToLocal(cloudData, localData, fallback);
        if (!(await pushLocalDataToCloud({ ...localData, ...cloudData, lastModified: fallback, lastDataUpdated: fallback }))) {
          return;
        }
      }

      setLastSyncTime(now);
      localStorage.setItem(LAST_SYNC_TIME_KEY, now.toISOString());
      localStorage.setItem(LAST_PULL_TIME_KEY, now.toISOString());
    } catch (error) {
      console.error('Sync error:', error);
      setSyncError(error instanceof Error ? error.message : 'Sync failed');
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [canSync, hasSecurityPassword, securityPassword, getLocalDataSnapshot, pushLocalDataToCloud, applyCloudToLocal]);

  // ── Resolve conflict ──
  const resolveConflict = useCallback(async (
    resolution: 'local' | 'cloud' | 'merge',
    mergedData?: Record<string, any>,
  ) => {
    if (!pendingConflict) return;

    const { localData, cloudData } = pendingConflict;
    const now = new Date().toISOString();

    try {
      isSyncingRef.current = true;
      setIsSyncing(true);

      if (resolution === 'local') {
        if (!(await pushLocalDataToCloud({ ...localData, lastModified: now, lastDataUpdated: now }))) {
          return;
        }
        localStorage.setItem('hrt-last-modified', now);
        localStorage.setItem(LAST_DATA_UPDATED_KEY, now);
      } else if (resolution === 'cloud') {
        applyCloudToLocal({ ...cloudData, lastModified: now, lastDataUpdated: now }, localData);
        localStorage.setItem('hrt-last-modified', now);
        localStorage.setItem(LAST_DATA_UPDATED_KEY, now);
        const updatedLocal = getLocalDataSnapshot();
        if (!(await pushLocalDataToCloud({ ...updatedLocal, lastModified: now, lastDataUpdated: now }))) {
          return;
        }
      } else if (resolution === 'merge' && mergedData) {
        applyCloudToLocal({ ...mergedData, lastModified: now, lastDataUpdated: now }, localData);
        localStorage.setItem('hrt-last-modified', now);
        localStorage.setItem(LAST_DATA_UPDATED_KEY, now);
        const updatedLocal = getLocalDataSnapshot();
        if (!(await pushLocalDataToCloud({ ...updatedLocal, lastModified: now, lastDataUpdated: now }))) {
          return;
        }
      }

      const syncNow = new Date();
      setLastSyncTime(syncNow);
      localStorage.setItem(LAST_SYNC_TIME_KEY, syncNow.toISOString());
      localStorage.setItem(LAST_PULL_TIME_KEY, syncNow.toISOString());
    } catch (error) {
      console.error('Conflict resolution error:', error);
      setSyncError(error instanceof Error ? error.message : 'Failed to resolve conflict');
    } finally {
      setPendingConflict(null);
      conflictPendingRef.current = false;
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [pendingConflict, pushLocalDataToCloud, applyCloudToLocal, getLocalDataSnapshot]);

  // ── Watch for local data changes → trigger unified sync ──
  useEffect(() => {
    if (!isAuthenticated || isLogoutInProgress()) return;

    const handleStorageChange = (e: StorageEvent) => {
      if (e.storageArea !== localStorage) return;
      const syncKeys = ['hrt-events', 'hrt-weight', 'hrt-lab-results', 'hrt-lang', 'hrt-calibration-model', 'hrt-apply-e2-learning-to-cpa', 'hrt-apply-cpa-inhibition-to-e2', 'hrt-theme-color', 'hrt-dark-mode'];
      if (e.key && syncKeys.includes(e.key)) performSync();
    };

    const handleLocalUpdate = () => performSync();

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('hrt-local-data-updated', handleLocalUpdate as EventListener);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('hrt-local-data-updated', handleLocalUpdate as EventListener);
    };
  }, [isAuthenticated, performSync]);

  // ── Periodic poll + initial sync ──
  useEffect(() => {
    if (!isAuthenticated || isLogoutInProgress()) return;

    // Initial sync on mount / auth change
    performSync();

    pollIntervalRef.current = setInterval(() => {
      if (shouldPullFromCloud()) performSync();
    }, PULL_CHECK_INTERVAL);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [isAuthenticated, performSync, shouldPullFromCloud]);

  return (
    <CloudSyncContext.Provider
      value={{ isSyncing, lastSyncTime, syncError, pendingConflict, resolveConflict }}
    >
      {children}
    </CloudSyncContext.Provider>
  );
};

export const useCloudSync = () => {
  const context = useContext(CloudSyncContext);
  if (!context) throw new Error('useCloudSync must be used within a CloudSyncProvider');
  return context;
};
