import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { v4 as uuidv4 } from "uuid";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { createServer } from "http";
import apiRoutes from "./api/routes";
import {
  errorHandler,
  rateLimit,
  configureRateLimiters,
} from "./middleware/auth";
import { setupWebSocketServer } from "./services/websocket-server";
import pool, { checkDbConnection } from "./config/database";
import { validateContractIds } from "./config/stellar";
import prisma from "./db/prisma";
import redisClient from "./config/redis";
import { validateSimulationAccount } from "./services/soroban-client";

const app = express();
const PORT = parseInt(process.env.PORT || "4000", 10);
const RESPONSE_TIMEOUT_MS = Number.parseInt(
  process.env.EXPRESS_RESPONSE_TIMEOUT_MS || "30000",
  10,
);

// Trust proxy when behind reverse proxy/load balancer (nginx, Cloudflare, AWS ALB)
// This ensures req.ip returns the real client IP from X-Forwarded-For header
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1); // Trust first proxy
}

// Initialize Redis-backed rate limiters
configureRateLimiters(redisClient);

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true,
  }),
);

// Add request-level correlation ID via middleware + structured logging
app.use(
  pinoHttp({
    logger,
    genReqId: (req: express.Request) => req.headers["x-request-id"] || uuidv4(),
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  req.setTimeout(RESPONSE_TIMEOUT_MS);
  res.setTimeout(RESPONSE_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: "Gateway timeout" });
    }
  });
  next();
});
app.use(rateLimit());

// API routes
app.use("/api", apiRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Error handler
app.use(errorHandler);

// Create HTTP server for both REST and WebSocket
const server = createServer(app);

// Attach WebSocket server
setupWebSocketServer(server);

async function closeResources() {
  try {
    await prisma.$disconnect();
    logger.info("[PulsarTrack] Prisma disconnected");
  } catch (err) {
    logger.error({ err }, "[PulsarTrack] Prisma disconnect error");
  }

  try {
    await pool.end();
    logger.info("[PulsarTrack] PostgreSQL pool closed");
  } catch (err) {
    logger.error({ err }, "[PulsarTrack] PostgreSQL disconnect error");
  }

  try {
    if (redisClient.status !== "end") {
      await redisClient.quit();
      logger.info("[PulsarTrack] Redis disconnected");
    }
  } catch (err) {
    logger.error({ err }, "[PulsarTrack] Redis disconnect error");
  }
}

async function shutdown(exitCode: number, closeServer = false) {
  if (closeServer && server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        logger.info("[PulsarTrack] HTTP server closed");
        resolve();
      });
    });
  }

  await closeResources();
  return exitCode;
}

async function gracefulShutdown(signal: string) {
  logger.info(`[PulsarTrack] Received ${signal}, shutting down gracefully...`);

  // Force shutdown after 10 seconds
  const forceShutdownTimer = setTimeout(() => {
    logger.error("[PulsarTrack] Forced shutdown after timeout");
    process.exit(1);
  }, 10000);

  try {
    const exitCode = await shutdown(0, true);
    clearTimeout(forceShutdownTimer);
    process.exit(exitCode);
  } catch (err) {
    clearTimeout(forceShutdownTimer);
    logger.error({ err }, "[PulsarTrack] Graceful shutdown failed");
    process.exit(1);
  }
}

// Ensure the application shuts down gracefully on OS signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start server
async function start() {
  // Validate contract IDs — throws in production, warns in development
  validateContractIds();

  // Validate simulation account
  await validateSimulationAccount();

  // Verify database connection — fail hard in production
  const dbOk = await checkDbConnection();
  if (!dbOk) {
    if (process.env.NODE_ENV === "production") {
      logger.fatal(
        "[DB] PostgreSQL connection failed — aborting in production",
      );
      process.exit(1);
    }
    logger.warn("[DB] Could not connect to PostgreSQL — running without DB");
  } else {
    logger.info("[DB] PostgreSQL connected");
  }

  // Verify Prisma client connectivity
  try {
    await prisma.$connect();
    logger.info("[DB] Prisma client connected");
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      logger.fatal("[DB] Prisma connection failed — aborting in production");
      process.exit(1);
    }
    logger.warn("[DB] Prisma client unavailable — running without ORM");
  }

  server.listen(PORT, () => {
    logger.info(`[PulsarTrack API] Listening on http://localhost:${PORT}`);
    logger.info(`[PulsarTrack WS]  WebSocket on ws://localhost:${PORT}/ws`);
    logger.info(
      `[Network]         ${process.env.STELLAR_NETWORK || "testnet"}`,
    );
  });
}

if (process.env.NODE_ENV !== "test") {
  start().catch(async (err) => {
    console.error("Failed to start server:", err);
    const exitCode = await shutdown(1);
    process.exit(exitCode);
  });
}

export { server };
