// 私聊路由入口。消息历史与生成链路分域，保持原有挂载顺序和公共导出。
import { Router } from 'express';
import historyRoutes from './chat/history.js';
import privateRoutes from './chat/private.js';

export { clearImageJudgeCounter, sanitizeReplyGuesses } from '../services/chat/replyGuesses.js';

const router = Router();
router.use(historyRoutes);
router.use(privateRoutes);
export default router;
