import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './chrome/AppShell.jsx';
import { BoardPage } from './pages/BoardPage.jsx';
import { LandingPage } from './pages/LandingPage.jsx';
import { NotFoundPage } from './pages/NotFoundPage.jsx';
import { ChangelogPage } from './pages/changelog/ChangelogPage.jsx';
import { SettingsPage } from './pages/settings/SettingsPage.jsx';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<LandingPage />} />
          <Route path="b/:code" element={<BoardPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="changelog" element={<ChangelogPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
