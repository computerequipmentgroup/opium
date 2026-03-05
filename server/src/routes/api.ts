import { Router } from "express";
import usersRouter from "./users.js";
import accountRouter from "./account.js";
import poolRouter from "./pool.js";

const router = Router();

// Mount route modules
router.use("/users", usersRouter);
router.use("/account", accountRouter);
router.use("/pool", poolRouter);

export default router;
