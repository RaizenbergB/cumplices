export { createStore, memoryBackend } from '../src/util.js';
import { mulberry32 } from '../src/engine.js';
export const mulberry32Safe = (seed) => mulberry32(seed);
