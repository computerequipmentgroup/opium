import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger("db");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

export function initDatabase(): Database.Database {
  if (db) {
    return db;
  }

  logger.info({ path: config.databasePath }, "Initializing database");

  db = new Database(config.databasePath);

  // Enable foreign keys and WAL mode for better performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Run schema
  const schemaPath = join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  logger.info("Database initialized successfully");

  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info("Database connection closed");
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", () => {
  closeDatabase();
  process.exit(0);
});
