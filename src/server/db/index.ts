import "server-only";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { env } from "../env";
import * as schema from "./schema";

// neon-http: one HTTPS round trip per query, no connection pool to warm up. Pooled host (-pooler) in DATABASE_URL.
// ponytail: neon-http has no interactive transactions; every write here is a single statement. Switch to neon-serverless if one is needed.
let db: ReturnType<typeof create> | undefined;
const create = () => drizzle({ client: neon(env().DATABASE_URL), schema });
export const getDb = () => (db ??= create());
