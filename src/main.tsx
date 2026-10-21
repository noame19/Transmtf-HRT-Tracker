import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { SecurityPasswordProvider } from './contexts/SecurityPasswordContext';
import { CloudSyncProvider } from './contexts/CloudSyncContext';
import './utils/consoleBridge';

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
