import { parentPort, workerData } from 'node:worker_threads';
import { evaluateBook } from './engine.js';
import { applyLorebookLayout } from './layout.js';

// No database or network access: imported regexes only execute in this worker.
try {
  const { operation, args } = workerData;
  const result = operation === 'evaluate' ? evaluateBook(...args)
    : operation === 'layout' ? applyLorebookLayout(...args)
      : (() => { throw new Error('Unknown lorebook worker operation'); })();
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
