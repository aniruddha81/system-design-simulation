"use client";
import ErrorPage from "./error";
import "./globals.css";

export default function GlobalError(props: { error: unknown; retry: () => void }) {
  return <html lang="en"><head><title>Page error</title></head><body><ErrorPage {...props} /></body></html>;
}
