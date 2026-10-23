import type { Metadata } from "next";
import { TemplatePicker } from "@/components/sandbox/TemplatePicker";

export const metadata: Metadata = {
  title: "Sandbox",
  description: "Design a system on a whiteboard and run it under load.",
  robots: { index: false },
};

export default function SandboxPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:py-14">
      <h1 className="text-3xl font-semibold tracking-tight text-(--text)">Sandbox</h1>
      <p className="mt-2 max-w-2xl text-(--text-muted)">
        Sketch a system, wire up what calls what, then run it against real traffic and a failure. Drafts stay in this browser.
      </p>
      <div className="mt-8">
        <TemplatePicker />
      </div>
    </div>
  );
}
