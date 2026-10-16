import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from '../../chrome/icons.jsx';
import './settings.css';

// What Settings will hold. Both are per browser (localStorage), never an account. Neither is built yet, so each
// says so plainly and offers no control.
const PLANNED = [
  {
    id: 'theme',
    title: 'Theme',
    body: 'Pick one of five themes: Light, Dark, Legacy, Pastel or Cyberpunk. Your choice stays in this browser only. Until the picker exists, Next Up follows this device’s light or dark mode.',
  },
  {
    id: 'name',
    title: 'Display name',
    body: 'The name your changes to boards are recorded under, so everyone can see who moved what. It stays in this browser only; there are no accounts.',
  },
];

export function SettingsPage() {
  const navigate = useNavigate();
  return (
    <div className="settings">
      <div className="settings-head">
        <button type="button" className="settings-back" onClick={() => navigate('/')}>
          <ChevronLeft />
          Home
        </button>
        <h1 className="settings-title display">Settings</h1>
        <p className="settings-sub">Saved in this browser only. Nothing here is built yet.</p>
      </div>

      <div className="settings-list glass-2">
        {PLANNED.map((item) => (
          <section key={item.id} className="settings-row" aria-labelledby={`settings-${item.id}`}>
            <div className="settings-row-head">
              <h2 id={`settings-${item.id}`} className="settings-row-title">{item.title}</h2>
              <span className="settings-soon">Coming soon</span>
            </div>
            <p className="settings-row-body">{item.body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
