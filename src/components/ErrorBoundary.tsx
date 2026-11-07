import { Component, type ReactNode } from "react";

/**
 * If the UI itself hits a bug, show a small recovery screen instead of a blank window. Nothing about
 * the error (which could include what the user was doing) is displayed, stored or sent anywhere.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="widget" style={{ left: 16, bottom: 16, width: 320 }} role="alert">
        <div className="task-panel">
          <div className="status status-error">Something went wrong in my display.</div>
          <p className="message">Your settings are safe. Reload me to carry on.</p>
          <div className="row">
            <button className="primary" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
