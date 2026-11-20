import { Router } from 'express';
import { guardPrivateChat, handlePrivateChat } from '../../services/chat/privateTurn.js';

const router = Router();
router.post('/characters/:id/chat', guardPrivateChat, handlePrivateChat);
export default router;
