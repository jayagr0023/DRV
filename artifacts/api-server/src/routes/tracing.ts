import { Router, type IRouter } from "express";
import {
  CreateTraceBody,
  ListLanguagesResponse,
  type ApiError,
} from "@workspace/api-zod";

const router: IRouter = Router();
const runnerUrl = process.env.RUNNER_URL ?? "http://127.0.0.1:7000";
const javaDescriptor = {
  id: "java",
  displayName: "Java",
  version: "21",
  fileExtension: ".java",
  starterTemplate: `public class Main {
    public static void main(String[] args) {
        System.out.println(42);
    }
}`,
  examples: [],
  limits: {
    maxSteps: 2000,
    totalTimeoutMs: 10000,
    compileTimeoutMs: 3000,
    traceTimeoutMs: 7000,
    maxOutputBytes: 10000,
    maxStdinBytes: 5000,
    maxCodeBytes: 20000,
  },
};

router.get("/languages", async (_req, res) => {
  let available = false;
  try {
    const response = await fetch(`${runnerUrl}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    available = response.ok;
  } catch {
    available = false;
  }

  const data = ListLanguagesResponse.parse({
    schemaVersion: "1.0.0",
    languages: available ? [javaDescriptor] : [],
  });
  res.json(data);
});

router.post("/trace", async (req, res): Promise<void> => {
  const parsed = CreateTraceBody.safeParse(req.body);
  if (!parsed.success) {
    const error: ApiError = {
      error: "Invalid trace request body.",
      code: "INVALID_TRACE_REQUEST",
    };
    res.status(400).json(error);
    return;
  }

  if (parsed.data.language.toLowerCase() !== "java") {
    const error: ApiError = {
      error: "This workspace currently accepts Java trace requests only.",
      code: "UNSUPPORTED_LANGUAGE",
    };
    res.status(400).json(error);
    return;
  }

  try {
    const response = await fetch(`${runnerUrl}/trace`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    res.status(response.status);
    res.setHeader("content-type", response.headers.get("content-type") ?? "application/json");
    res.send(body);
  } catch {
    const error: ApiError = {
      error: "No isolated Java runner is available. The submitted source code was not executed.",
      code: "TRACE_RUNNER_UNAVAILABLE",
    };
    res.status(503).json(error);
  }
});

export default router;