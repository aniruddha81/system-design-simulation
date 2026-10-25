import type { Instrumentation } from "next";
import { log } from "./server/log";

export function register() { log("info", "server_started"); }
export const onRequestError: Instrumentation.onRequestError = () => { log("error", "server_error"); };
