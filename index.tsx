import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './src/App';
import { ThemeProvider } from './src/contexts/ThemeContext';
import { AuthProvider } from './src/contexts/AuthContext';
import { SecurityPasswordProvider } from './src/contexts/SecurityPasswordContext';
import { CloudSyncProvider } from './src/contexts/CloudSyncContext';
import './src/utils/consoleBridge';

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
