import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/ui/AppShell';
import { HomePage } from './pages/HomePage';
import { CampaignsPage } from './pages/CampaignsPage';
import { StreamsPage } from './pages/StreamsPage';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/fb/campaigns/:id/streams" element={<StreamsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
