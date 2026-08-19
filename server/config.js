import "dotenv/config";

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  isProd: env.NODE_ENV === "production",
  databaseUrl: env.DATABASE_URL,
  appDatabase: env.APP_DATABASE || "ledger_shop",
  jwtSecret: env.JWT_SECRET || "dev-secret-change-me-in-production",
  jwtExpiresIn: env.JWT_EXPIRES_IN || "8h",
  clientOrigin: env.CLIENT_ORIGIN || "*",
  superAdmin: {
    username: env.SUPER_ADMIN_USERNAME || "superadmin",
    password: env.SUPER_ADMIN_PASSWORD || "SuperAdmin@123",
    email: env.SUPER_ADMIN_EMAIL || "platform@ledger.app"
  }
};
