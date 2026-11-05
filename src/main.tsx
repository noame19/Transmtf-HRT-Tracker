import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { SecurityPasswordProvider } from './contexts/SecurityPasswordContext';
import { CloudSyncProvider } from './contexts/CloudSyncContext';
import './utils/consoleBridge';

// Android WebView 的 backdrop-filter 不是 GPU 合成，而是整屏回读后再模糊。
// 本 app 的吸顶头部和底部标签栏各有一层玻璃，任何一次整页重绘（切 tab、
// 滚动、开弹窗）都要把这两层重新算一遍，在手机上很容易吃掉几百毫秒。
// 网页端不缺这点性能，只给安卓降级：同色、不透明、不模糊（见 index.css
// 的 .is-android 规则）。
if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)) {
    document.documentElement.classList.add('is-android');
}

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            <BrowserRouter>
                <ThemeProvider>
                    <AuthProvider>
                        <SecurityPasswordProvider>
                            <CloudSyncProvider>
                                <App />
                            </CloudSyncProvider>
                        </SecurityPasswordProvider>
                    </AuthProvider>
                </ThemeProvider>
            </BrowserRouter>
        </React.StrictMode>
    );
}
