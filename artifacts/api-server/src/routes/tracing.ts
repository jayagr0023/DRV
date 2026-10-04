import { Router, type IRouter } from "express";
import {
  CreateTraceBody,
  ListLanguagesResponse,
  type ApiError,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/languages", (_req, res) => {
  const data = ListLanguagesResponse.parse({
    schemaVersion: "1.0.0",
    // Do not advertise Java until a sandboxed runner can execute it.
    languages: [],
  });
  res.json(data);
});

router.post("/trace", (req, res): void => {
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

  const error: ApiError = {
    error:
      "No isolated Java runner is configured. The submitted source code was not executed.",
    code: "TRACE_RUNNER_UNAVAILABLE",
  };
  res.status(503).json(error);
});

export default router;