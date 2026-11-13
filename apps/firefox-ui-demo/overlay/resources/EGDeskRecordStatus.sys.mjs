// 기록 상태 (top bar): what the Desk says about its own automatic record on this PC.
// Pure rules. The screen reports each real write (ok or failed) with the clock
// time it happened; nothing here invents a time, so an unsaved Desk shows nothing.
//   saved  → "이 PC에 기록됨 10:34"            (quiet text)
//   failed → "기록 실패" + [다시 기록] button   (the last good time stays in the tooltip)

export const RECORD_STATUS_INITIAL = Object.freeze({ savedAt: null, failed: false });

const validTime = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

// One write result → the next status. A write that did not run changes nothing.
export function nextRecordStatus(previous, { saved, at } = {}) {
  const prior = previous && typeof previous === 'object' ? previous : RECORD_STATUS_INITIAL;
  if (saved === true) return validTime(at) ? { savedAt: at, failed: false } : prior;
  if (saved === false) return { savedAt: validTime(prior.savedAt) ? prior.savedAt : null, failed: true };
  return prior;
}

// Local 24-hour clock text, "10:34" or "10:34:02".
export function recordClock(at, { seconds = false } = {}) {
  if (!validTime(at)) return '';
  const date = new Date(at);
  const two = value => String(value).padStart(2, '0');
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return seconds ? `${clock}:${two(date.getSeconds())}` : clock;
}

export function recordStatusView(status) {
  const savedAt = validTime(status?.savedAt) ? status.savedAt : null;
  if (status?.failed === true) {
    return {
      state: 'failed', hidden: false, text: '기록 실패', retry: true,
      title: savedAt ? `이 PC에 기록하지 못했습니다. 마지막 기록 ${recordClock(savedAt, { seconds: true })}` : '이 PC에 기록하지 못했습니다.',
    };
  }
  if (savedAt === null) return { state: 'none', hidden: true, text: '', title: '', retry: false };
  return {
    state: 'saved', hidden: false, text: `이 PC에 기록됨 ${recordClock(savedAt)}`,
    title: `이 PC에 기록됨 ${recordClock(savedAt, { seconds: true })}`, retry: false,
  };
}
