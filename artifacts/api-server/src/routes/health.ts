import { Router, type IRouter } from "express";
import {
  GetDryRunHealthResponse,
  HealthCheckResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/health", (_req, res) => {
  const data = GetDryRunHealthResponse.parse({ status: "degraded" });
  res.json(data);
});

export default router;
