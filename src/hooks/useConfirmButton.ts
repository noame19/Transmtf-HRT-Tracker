import { useCallback, useRef, useState } from 'react';

type Key = string;

/**
 * 双击确认状态机:同一个"容器"内同一时刻只有一个按钮处于"等待第二次点击"状态。
 * - 第一次点 X:pending = X
 * - 第二次点 X(在等待中):触发 onTrigger,pending = null
 * - 等待 X 时点 Y:pending 切到 Y,旧 X 不触发
 * - reset():外部主动清空(用于"X 关闭弹窗"、"翻页重置"等场景)
 */
export interface UseConfirmButtonResult {
  pending: Key | null;
  request: (key: Key, opts?: { onTrigger?: () => void }) => void;
  reset: () => void;
}

export function useConfirmButton(): UseConfirmButtonResult {
  const [pending, setPending] = useState<Key | null>(null);
  // 用 ref 持有"当前 pending 按钮的 onTrigger",避免 useCallback 闭包过期
  const triggerRef = useRef<(() => void) | null>(null);
  // 用 ref 同步追踪最新 pending,避免 setState 回调里读 prev 时 React StrictMode 重复执行导致副作用被调两次
  const pendingRef = useRef<Key | null>(null);
  pendingRef.current = pending;

  const request = useCallback((key: Key, opts?: { onTrigger?: () => void }) => {
    if (pendingRef.current === key) {
      // 第二次点同一按钮 → 触发(同步执行,不放在 setState 回调里)
      opts?.onTrigger?.();
      triggerRef.current = null;
      setPending(null);
    } else {
      // 切到新按钮(包含从 null 切到 key),旧 onTrigger 被覆盖
      triggerRef.current = opts?.onTrigger ?? null;
      setPending(key);
    }
  }, []);

  const reset = useCallback(() => {
    triggerRef.current = null;
    setPending(null);
  }, []);

  return { pending, request, reset };
}