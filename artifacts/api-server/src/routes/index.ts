import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tracingRouter from "./tracing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tracingRouter);

export default router;
