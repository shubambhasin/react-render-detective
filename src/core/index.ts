export { Detective, getDetective } from "./store.js";
export { defaultConfig, mergeConfig, shouldInstrument, detectDev, matches } from "./config.js";
export { diffProps, shallowEqual } from "./compare.js";
export { diagnose, severityFor } from "./diagnose.js";
export type { DiagnosisInput } from "./diagnose.js";
export { inspect, formatInspected, valueType, isPlainObject, isReactElement } from "./inspect.js";
export { RingBuffer } from "./ringBuffer.js";
export * from "./types.js";
