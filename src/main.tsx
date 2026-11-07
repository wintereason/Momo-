import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Momo has two windows built from this one page: #bar is the dictation bar, anything else is the Settings app.
// Each loads only its own code.
const route = window.location.hash.replace("#", "");
const load: Promise<{ default: ComponentType }> = route === "bar" ? import("./bar/BarApp") : import("./settings/SettingsApp");

void load.then(({ default: Root }) => {
  createRoot(document.getElementById("root")!).render(
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>,
  );
});
