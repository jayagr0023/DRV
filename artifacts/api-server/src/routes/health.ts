import { Router, type IRouter } from "express";
import {
  GetDryRunHealthResponse,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const runnerUrl = process.env.RUNNER_URL ?? "http://127.0.0.1:7000";

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/health", async (_req, res) => {
  let status: "ok" | "degraded" = "degraded";
  try {
    const response = await fetch(`${runnerUrl}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) status = "ok";
  } catch {
    status = "degraded";
  }

  const data = GetDryRunHealthResponse.parse({ status });
  res.json(data);
});

export default router;
