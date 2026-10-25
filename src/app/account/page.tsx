import type { Metadata } from "next";
import { emailConfigured } from "@/server/email";
import { AccountView } from "./account-view";

export const metadata: Metadata = { title: "Account", robots: { index: false } };

export default function AccountPage() {
  // Optional OAuth buttons appear only when the provider is configured on the server.
  const providers = [process.env.GITHUB_CLIENT_ID && "github", process.env.GOOGLE_CLIENT_ID && "google"].filter(Boolean) as ("github" | "google")[];
  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <AccountView providers={providers} emailEnabled={emailConfigured()} />
    </div>
  );
}
