import { embedBatch, embedText } from '../vectorClient.js';
import { createLorebookVectorStore } from './vectorStore.js';

// Separate from the memory corpus. Restart after changing the embedding model.
const store = createLorebookVectorStore({ embedBatch, embedText });
export const recallLorebook = (book, query) => store.recall(book, query);
export const warmLorebook = book => store.warm(book);
