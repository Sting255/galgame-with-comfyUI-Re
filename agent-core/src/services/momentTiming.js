const HOUR_MS = 60 * 60 * 1000;

// 老设置未记录模式时，1 仍视为默认，其余非零值对应具体时间档。
export function isDefaultMomentTiming(features) {
  return (features.momentFreq ?? 1) === 1 && features.momentFreqMode !== 'interval';
}

/** 具体时间档首次与后续均以 2 小时 / freq 为中心，均匀浮动 ±20%。 */
export function getMomentDelay(features, { initial = false, random = Math.random } = {}) {
  if (isDefaultMomentTiming(features) || (features.momentFreq ?? 1) <= 0) {
    return (initial ? 1 + random() * 3 : 2 + random() * 6) * HOUR_MS;
  }
  return (2 * HOUR_MS / Math.max(0.01, features.momentFreq)) * (0.8 + random() * 0.4);
}
