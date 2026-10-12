import { BackIcon, GearIcon } from './Icons';

interface Props {
  view: 'main' | 'settings';
  /** The site this panel's tab is on, for orientation. Not a control. */
  context: { host: string | null; title: string | null } | null;
  onOpenSettings: () => void;
  onBack: () => void;
}

export function Header({ view, context, onOpenSettings, onBack }: Props) {
  if (view === 'settings') {
    return (
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Settings</h1>
      </header>
    );
  }
  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-mark" src="../icons/pilot-128.png" width="28" height="28" alt="" aria-hidden="true" />
        <div className="brand-copy">
          <h1>Pilot</h1>
          {context?.host && (
            <span className="site-context" title={context.title ?? undefined}>
              {context.host}
            </span>
          )}
        </div>
      </div>
      <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="Open settings">
        <GearIcon />
      </button>
    </header>
  );
}
