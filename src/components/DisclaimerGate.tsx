import { useEffect, useState } from 'react';
import DisclaimerModal from './DisclaimerModal';

/**
 * 免责声明全局 Gate（2026-07-24 新增）。
 *
 * 设计:
 *   - App 启动时挂载（跟 SecurityPasswordGate / OIDCBindingGate 一样挂在 App.tsx 顶层）
 *   - 检查 localStorage.hrt-disclaimer-acknowledged
 *     - 没这个 key → 渲染 DisclaimerModal,点 OK 时写 key + 关闭
 *     - 有这个 key → 不渲染任何东西（彻底静默,不干扰其他页面）
 *   - 用户随时可以从设置页主动打开免责声明（走 SettingsPage 自己的 modal 实例,
 *     不影响本 Gate 的 key 状态）
 *
 * key 选择 localStorage 而不是 IndexedDB:重装 app / 换设备会清掉,会重弹一次。
 * 这跟"新设备用户应该重新看免责"的直觉一致,且本 fork 没服务端,IndexedDB
 * 反而会让人困惑"为什么换了设备还记得我读过"。
 */
const DISCLAIMER_ACK_KEY = 'hrt-disclaimer-acknowledged';

const DisclaimerGate: React.FC = () => {
    // null = 还没检查完 localStorage;true = 显示 modal;false = 不显示
    const [show, setShow] = useState<boolean | null>(null);

    useEffect(() => {
        try {
            const acked = localStorage.getItem(DISCLAIMER_ACK_KEY);
            setShow(acked !== '1');
        } catch {
            // localStorage 不可用（极少见,例如隐私模式禁用了） → 当作未读,
            // 仍然弹一次,但点 OK 时 try/catch 兜底,不让写 key 失败炸 UI。
            setShow(true);
        }
    }, []);

    const handleAcknowledge = () => {
        try {
            localStorage.setItem(DISCLAIMER_ACK_KEY, '1');
        } catch {
            /* swallow:写不进也无所谓,下次启动会再弹一次 */
        }
        setShow(false);
    };

    if (show !== true) return null;

    return <DisclaimerModal isOpen onClose={handleAcknowledge} />;
};

export default DisclaimerGate;