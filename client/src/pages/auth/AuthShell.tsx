import type { ReactNode } from 'react';

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth-page">
      <main className="auth-card" id="main">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden>
            W
          </span>
          <span className="brand-name">WorkPilot AI</span>
        </div>
        <h1 className="auth-title">{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
        {footer && <div className="auth-footer">{footer}</div>}
      </main>
    </div>
  );
}
