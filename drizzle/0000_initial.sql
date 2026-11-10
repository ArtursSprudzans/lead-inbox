CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE users (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), email TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX sessions_expires_at ON sessions(expires_at);
--> statement-breakpoint
CREATE TABLE source_leads (company_id TEXT NOT NULL REFERENCES companies(id), id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (company_id, id));
--> statement-breakpoint
CREATE TABLE booking_events (company_id TEXT NOT NULL REFERENCES companies(id), id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (company_id, id));
--> statement-breakpoint
CREATE TABLE company_revisions (company_id TEXT PRIMARY KEY REFERENCES companies(id), revision TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
