import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const admins = sqliteTable('wb_admins', {
  username: text().primaryKey(), password_hash: text().notNull(), version: integer().notNull().default(0), created_at: real().notNull(),
});
export const accounts = sqliteTable('wb_accounts', {
  id: text().primaryKey(), uid: text().notNull().unique(), name: text().notNull(), credential: text().notNull(),
  enabled: integer().notNull().default(1), balance: real().notNull().default(0), balance_total: real().notNull().default(0),
  credits: text().notNull().default('{}'), updated_at: real().notNull(), last_used_at: real().notNull().default(0), cool_until: real().notNull().default(0),
});
export const keys = sqliteTable('wb_keys', {
  id: text().primaryKey(), name: text().notNull(), key_hash: text().notNull().unique(), prefix: text().notNull(),
  enabled: integer().notNull().default(1), request_limit: integer().notNull().default(0), requests: integer().notNull().default(0),
  tokens: real().notNull().default(0), account_id: text(), group_id: text(), created_at: real().notNull(),
});
export const models = sqliteTable('wb_models', { id: text().primaryKey(), enabled: integer().notNull().default(1), detail: text().notNull() });
export const groups = sqliteTable('wb_groups', { id: text().primaryKey(), name: text().notNull(), models: text().notNull() });
export const logs = sqliteTable('wb_logs', {
  id: text().primaryKey(), key_id: text().notNull(), account_id: text().notNull(), model: text().notNull(), status: integer().notNull(),
  input_tokens: real().notNull().default(0), output_tokens: real().notNull().default(0), duration_ms: real().notNull(), created_at: real().notNull(),
}, table => [index('wb_logs_time').on(table.created_at, table.id)]);
export const leases = sqliteTable('wb_leases', { id: text().primaryKey(), owner: text().notNull(), until_at: real().notNull() });
export const limits = sqliteTable('wb_limits', { id: text().primaryKey(), count: integer().notNull(), expires_at: real().notNull() });
export const loginSessions = sqliteTable('wb_login_sessions', { id: text().primaryKey(), payload: text().notNull(), expires_at: real().notNull() });
