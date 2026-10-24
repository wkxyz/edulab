export const clamp = (n, min = 0, max = 1) => Math.min(max, Math.max(min, n));

export function selectionFromPoints(a, b) {
  const x1 = clamp(a.x), y1 = clamp(a.y), x2 = clamp(b.x), y2 = clamp(b.y);
  return {x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1)};
}

export function cropBounds(selection, imageWidth, imageHeight) {
  if (![selection.x, selection.y, selection.width, selection.height, imageWidth, imageHeight].every(Number.isFinite)
      || imageWidth <= 0 || imageHeight <= 0 || selection.width <= 0 || selection.height <= 0) {
    throw new Error('请框选完整的题目。');
  }
  const x = Math.round(clamp(selection.x) * imageWidth);
  const y = Math.round(clamp(selection.y) * imageHeight);
  const right = Math.round(clamp(selection.x + selection.width) * imageWidth);
  const bottom = Math.round(clamp(selection.y + selection.height) * imageHeight);
  if (right <= x || bottom <= y) throw new Error('请选择更大的题目区域。');
  return {x, y, width: right - x, height: bottom - y};
}

export function taskPhase(task) {
  if (task.status === 'queued') return {key: 'queued', index: 0, label: '等待开始', detail: '前面的讲解处理完成后，会自动开始。'};
  const phases = {
    recognizing: {index: 0, label: '正在识别题目', detail: '读取题干、数字和图形条件。'},
    solving: {index: 1, label: '正在分析解法', detail: '梳理解题步骤和讲解思路。'},
    checking: {index: 1, label: '正在复核解答', detail: '检查答案和推导是否一致。'},
    voicing: {index: 2, label: '正在生成配音', detail: '把解题步骤制作成语音讲解。'},
    rendering: {index: 3, label: '正在制作视频', detail: '将配音、公式和动态板书合成视频。'},
  };
  return {key: task.stage, ...(phases[task.stage] || phases.recognizing)};
}

export function photoError(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file?.type)) return '请选择 PNG、JPEG 或 WebP 图片。';
  if (file.size > 4194304) return '图片不能超过4MB。';
  if (!file.size) return '图片是空的，请重新选择。';
  return '';
}

export function formatTime(seconds) {
  const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

export function chapterStarts(result) {
  const steps = result.steps || [], segments = result.segments || [];
  const offset = Math.max(0, segments.length - steps.length);
  return steps.map((_, i) => Number.isFinite(segments[i + offset]?.at) ? Math.max(0, segments[i + offset].at) : 0);
}
