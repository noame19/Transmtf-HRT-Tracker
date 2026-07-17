// @vitest-environment happy-dom
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useConfirmButton } from './useConfirmButton';

describe('useConfirmButton', () => {
  it('点击 X 后当前等待标记变成 X', () => {
    const { result } = renderHook(() => useConfirmButton());
    act(() => result.current.request('X'));
    expect(result.current.pending).toBe('X');
  });

  it('等待 X 时再次点 X 触发 X 的处理函数并清空标记', () => {
    const onX = vi.fn();
    const { result } = renderHook(() => useConfirmButton());
    act(() => result.current.request('X'));
    act(() => result.current.request('X', { onTrigger: onX }));
    expect(onX).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeNull();
  });

  it('等待 X 时点 Y 切到 Y,X 恢复,handler 不触发', () => {
    const onX = vi.fn();
    const onY = vi.fn();
    const { result } = renderHook(() => useConfirmButton());
    act(() => result.current.request('X', { onTrigger: onX }));
    act(() => result.current.request('Y', { onTrigger: onY }));
    expect(onX).not.toHaveBeenCalled();
    expect(onY).not.toHaveBeenCalled();
    expect(result.current.pending).toBe('Y');
  });

  it('切到 Y 后再点 Y 才触发 Y,不在第一次点 Y 时触发', () => {
    const onY = vi.fn();
    const { result } = renderHook(() => useConfirmButton());
    act(() => result.current.request('X'));
    act(() => result.current.request('Y', { onTrigger: onY }));
    expect(onY).not.toHaveBeenCalled();
    act(() => result.current.request('Y', { onTrigger: onY }));
    expect(onY).toHaveBeenCalledTimes(1);
  });

  it('reset() 清空当前等待标记', () => {
    const { result } = renderHook(() => useConfirmButton());
    act(() => result.current.request('X'));
    act(() => result.current.reset());
    expect(result.current.pending).toBeNull();
  });
});