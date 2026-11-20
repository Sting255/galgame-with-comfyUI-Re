/** Pure time and sleep rules shared by schedule management and clothing selection. */
export const SLEEP_KINDS = { MAIN: 'main', NAP: 'nap' };
export const NAP_MAX_MINUTES = 90;
export const NAP_WINDOW_START_MINUTE = 7 * 60;
export const NAP_WINDOW_END_MINUTE = 21 * 60;

export function timeToMinutes(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

function blockDurationMinutes(block) {
  if (!block) return 0;
  const start = timeToMinutes(block.startTime);
  const end = timeToMinutes(block.endTime);
  if (end === start) return 24 * 60;
  return end > start ? end - start : end + 24 * 60 - start;
}

/** The single schedule-level classifier for main sleep versus a daytime nap. */
export function classifySleepBlock(block) {
  if (!block || Number(block.replyDelay) !== -1) return null;
  if (block.sleepKind === SLEEP_KINDS.MAIN || block.sleepKind === SLEEP_KINDS.NAP) return block.sleepKind;
  if (block.forcedSleep === 1 || block.forcedSleep === true) return SLEEP_KINDS.MAIN;

  const duration = blockDurationMinutes(block);
  const sameDay = timeToMinutes(block.endTime) > timeToMinutes(block.startTime);
  const insideDayWindow = sameDay
    && timeToMinutes(block.startTime) >= NAP_WINDOW_START_MINUTE
    && timeToMinutes(block.endTime) <= NAP_WINDOW_END_MINUTE;
  if (duration > 0 && duration <= NAP_MAX_MINUTES && insideDayWindow) return SLEEP_KINDS.NAP;
  return SLEEP_KINDS.MAIN;
}

export function isMainSleepBlock(block) {
  return classifySleepBlock(block) === SLEEP_KINDS.MAIN;
}

/** True for [startTime, endTime), including intervals that cross midnight. */
export function isInTimeSlot(startTime, endTime, now) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  if (endMin < startMin) return nowMin >= startMin || nowMin < endMin;
  return nowMin >= startMin && nowMin < endMin;
}

export function findActivityAtTime(activities, now) {
  if (!Array.isArray(activities)) return null;
  const index = activities.findIndex(activity => activity?.startTime && activity?.endTime
    && activity.startTime !== activity.endTime && isInTimeSlot(activity.startTime, activity.endTime, now));
  return index < 0 ? null : { activity: activities[index], index };
}

export function intervalDurationMinutes(activity) {
  if (!activity?.startTime || !activity?.endTime || activity.startTime === activity.endTime) return 0;
  const start = timeToMinutes(activity.startTime);
  const end = timeToMinutes(activity.endTime);
  return end > start ? end - start : end + 1440 - start;
}

/** Keep a split cohabitation sleep segment's original main/nap classification. */
export function classifySleepBlockInSchedule(schedule, index) {
  const block = schedule?.[index];
  const direct = classifySleepBlock(block);
  if (direct !== SLEEP_KINDS.NAP || block.sleepKind === SLEEP_KINDS.NAP) return direct;

  // A main sleep can be split entirely into short daytime fragments. Rebuild
  // its continuous interval rather than requiring one fragment to remain main.
  const seen = new Set([block]);
  let startTime = block.startTime;
  let endTime = block.endTime;
  for (const direction of ['previous', 'next']) {
    while (true) {
      const adjacent = schedule.find(activity => activity && !seen.has(activity)
        && Number(activity.replyDelay) === -1
        && (direction === 'previous' ? activity.endTime === startTime : activity.startTime === endTime));
      if (!adjacent) break;
      seen.add(adjacent);
      if (classifySleepBlock(adjacent) === SLEEP_KINDS.MAIN) return SLEEP_KINDS.MAIN;
      if (direction === 'previous') startTime = adjacent.startTime;
      else endTime = adjacent.endTime;
    }
  }
  return classifySleepBlock({ ...block, startTime, endTime, sleepKind: undefined });
}

/** Read the sparse outfit marker active at a minute of this day's schedule. */
export function getScheduleOutfitMarkerAt(activities, minute) {
  if (!Array.isArray(activities) || !activities.length) return null;
  const target = ((Math.trunc(minute) % 1440) + 1440) % 1440;
  const minuteOf = value => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
    return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  };
  const ordered = activities.map(activity => ({ activity, start: minuteOf(activity?.startTime), end: minuteOf(activity?.endTime) }))
    .filter(({ activity, start, end }) => activity?.startTime && activity?.endTime
      && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start < 1440
      && end >= 0 && end < 1440 && start !== end)
    .sort((a, b) => a.start - b.start);
  const orderedActivities = ordered.map(({ activity }) => activity);
  const currentPosition = ordered.findIndex(({ start, end }) => end < start
    ? target >= start || target < end
    : target >= start && target < end);
  if (currentPosition < 0) return null;

  const current = ordered[currentPosition];
  const markerOf = activity => activity?.outfit != null && String(activity.outfit).trim()
    ? activity.outfit : null;
  const currentMarker = markerOf(current.activity);
  const currentIsMainSleep = classifySleepBlockInSchedule(orderedActivities, currentPosition) === SLEEP_KINDS.MAIN;
  if (currentMarker != null) return currentMarker === 'sleep' && !currentIsMainSleep ? null : currentMarker;

  // A cross-midnight activity observed after midnight belongs to the previous
  // occurrence of this schedule row. Earlier rows in today's array are future
  // changes, so do not wrap around and inherit one of them.
  const startsPreviousDay = current.end < current.start && target < current.end;
  if (startsPreviousDay) return null;

  for (let position = currentPosition - 1; position >= 0; position--) {
    const previous = ordered[position];
    if (classifySleepBlockInSchedule(orderedActivities, position) === SLEEP_KINDS.MAIN) break;
    const marker = markerOf(previous.activity);
    if (marker != null) return marker === 'sleep' ? null : marker;
  }
  return null;
}
