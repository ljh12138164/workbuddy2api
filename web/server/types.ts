export interface RuntimeEnv {
  DB?: D1Database;
  ASSETS?: Fetcher;
  CLOUDFLARE_ACCOUNT_ID?: string;
  D1_DATABASE_ID?: string;
  D1_API_TOKEN?: string;
  ADMIN_JWT_SECRET?: string;
  DATA_ENCRYPTION_KEY?: string;
  WORKBUDDY_DEVICE_TOKEN?: string;
}

export interface Credential {
  auth: { accessToken: string; refreshToken: string; domain?: string; expiresAt?: number; expiresIn?: number; refreshExpiresAt?: number; [key: string]: unknown };
  account: { uid: string; nickname?: string; enterpriseId?: string; type?: string; [key: string]: unknown };
}

export interface AccountRow {
  id: string;
  uid: string;
  name: string;
  credential: string;
  enabled: number;
  balance: number;
  balance_total: number;
  credits: string;
  updated_at: number;
  last_used_at: number;
  cool_until: number;
}

export interface KeyRow {
  id: string;
  name: string;
  key_hash: string;
  prefix: string;
  enabled: number;
  request_limit: number;
  requests: number;
  tokens: number;
  account_id: string | null;
  group_id: string | null;
  created_at: number;
}
