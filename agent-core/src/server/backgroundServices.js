import { startMomentScheduler, stopMomentScheduler } from '../services/momentScheduler.js';
import { startSpecialMomentScheduler, stopSpecialMomentScheduler } from '../services/scheduleSpecialMoment.js';
import { startProactiveChatScheduler, stopProactiveChatScheduler } from '../services/proactiveChatScheduler.js';
import { startEventScheduler, stopEventScheduler } from '../services/eventScheduler.js';
import { startDisturbScheduler, stopDisturbScheduler } from '../services/disturbModeScheduler.js';
import { startReplyQueueScheduler, stopReplyQueueScheduler } from '../services/replyQueueScheduler.js';
import { startIntimateAutoThrust, stopIntimateAutoThrust } from '../services/intimateAutoThrust.js';
import { initialize, stopScheduleManager } from '../services/scheduleManager.js';
import { startScheduler, stopScheduler } from '../services/imageCompressor.js';
import { startMailboxScheduler, stopMailboxScheduler } from '../services/mailboxScheduler.js';
import { startWeatherScheduler, stopWeatherScheduler } from '../services/weatherService.js';
import { startGroupIdleScheduler, stopGroupIdleScheduler } from '../services/groupIdleScheduler.js';
import { startKnowledgeSyncScheduler, stopKnowledgeSyncScheduler } from '../services/imagePromptKnowledge.js';
import { startConsolidationScheduler, stopConsolidationScheduler } from '../services/memory/consolidationScheduler.js';
import { startItemScheduler, stopItemScheduler } from '../services/itemScheduler.js';

// 启动顺序保持原 app.js 口径；每项必须成对登记退出函数。
const services = [
  [startMomentScheduler, stopMomentScheduler],
  [startSpecialMomentScheduler, stopSpecialMomentScheduler],
  [startProactiveChatScheduler, stopProactiveChatScheduler],
  [startEventScheduler, stopEventScheduler],
  [startDisturbScheduler, stopDisturbScheduler],
  [startReplyQueueScheduler, stopReplyQueueScheduler],
  [startIntimateAutoThrust, stopIntimateAutoThrust],
  [initialize, stopScheduleManager],
  [startScheduler, stopScheduler],
  [startMailboxScheduler, stopMailboxScheduler],
  [startWeatherScheduler, stopWeatherScheduler],
  [startGroupIdleScheduler, stopGroupIdleScheduler],
  [startKnowledgeSyncScheduler, stopKnowledgeSyncScheduler],
  [startConsolidationScheduler, stopConsolidationScheduler],
  [startItemScheduler, stopItemScheduler],
];
export function startBackgroundServices() { for (const [start] of services) start(); }
export function stopBackgroundServices() {
  for (const [, stop] of [...services].reverse()) {
    try { stop(); } catch (error) { console.warn(`[shutdown] ${stop.name}: ${error.message}`); }
  }
}
