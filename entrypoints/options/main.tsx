import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DialogProvider } from '@/components/Dialog';
import { applyTheme } from '@/lib/theme';
import '@/assets/tailwind.css';

applyTheme('system'); // 解锁前先跟随系统，解锁后由设置覆盖

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DialogProvider>
      <App />
    </DialogProvider>
  </React.StrictMode>,
);
