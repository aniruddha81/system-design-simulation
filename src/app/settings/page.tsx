import type { Metadata } from "next";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = {
  title: "Settings",
  description: "Motion, theme, analytics and your local data.",
  robots: { index: false },
};

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-12">
      <h1 className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">Settings</h1>
      <p className="mt-3 text-ink-2">Set up your notebook. Appearance, motion and data stay on this device.</p>
      <SettingsForm />
    </div>
  );
}
