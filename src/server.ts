import { createApp } from "./app.js";
import { config } from "./lib/config.js";
import { prisma } from "./lib/db.js";

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Badminton Queue API listening on ${config.port}`);
});

const shutdown = async (signal: string) => {
  console.log(`${signal} received; shutting down.`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

