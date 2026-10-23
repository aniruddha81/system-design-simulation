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
      <h1 className="text-4xl font-semibold tracking-tight">Settings</h1>
      <SettingsForm />
    </div>
  );
}
