import { SettingsForm } from '../shared/SettingsForm';

export default function OptionsApp() {
  return (
    <div className="options">
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>Pilot – Settings</h1>
      <SettingsForm />
    </div>
  );
}
