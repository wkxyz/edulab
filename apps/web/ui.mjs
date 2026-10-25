import {getCapability} from './capabilities.mjs';

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
  if (task.mode === 'export') return task.status === 'queued'
    ? {key: 'queued', index: 0, label: '等待导出视频', detail: '已有讲解与配音已保留，轮到后开始制作 MP4。'}
    : {key: 'rendering', index: 0, label: '正在导出视频', detail: '使用已有讲解与配音制作 MP4，无需再次解题。'};
  if (task.mode === 'narration') return task.status === 'queued'
    ? {key: 'queued', index: 0, label: '等待生成配音讲解', detail: '已核对的原题与答案已保留，轮到后开始配音。'}
    : task.stage === 'rendering' || task.stage === 'building'
      ? {key: task.stage, index: 1, label: '正在制作配音网页', detail: '将已有讲解与配音组合为可播放网页，MP4 可稍后单独导出。'}
      : {key: task.stage, index: 0, label: '正在生成配音', detail: '使用已核对的解题步骤生成配音，无需再次解题。'};
  if (task.status === 'queued') return {key: 'queued', index: 0, label: '等待开始', detail: '前面的讲解处理完成后，会自动开始。'};
  const interactive = getCapability(task.capability).kind === 'interactive';
  const phases = {
    recognizing: {index: 0, label: '正在识别题目', detail: '读取题干、数字和图形条件。'},
    solving: {index: 1, label: '正在分析解法', detail: '梳理解题步骤和讲解思路。'},
    checking: {index: 1, label: '正在复核解答', detail: '检查答案和推导是否一致。'},
    voicing: {index: 2, label: '正在生成配音', detail: '把解题步骤制作成语音讲解。'},
    rendering: {index: 3, label: '正在制作视频', detail: '将配音、公式和动态板书合成视频。'},
  };
  if (task.delivery === 'lesson' && !interactive) {
    phases.rendering = {index: 2, label: '正在制作讲解网页', detail: '整理公式、图形与解题步骤，完成后可按需生成配音。'};
    phases.voicing = phases.rendering;
    phases.building = phases.rendering;
  }
  if (interactive) {
    phases.rendering = {index: 2, label: '正在制作交互讲解', detail: '生成图形、参数控件和分步说明。'};
    phases.voicing = phases.rendering;
    phases.building = phases.rendering;
  }
  return {key: task.stage, ...(phases[task.stage] || phases.recognizing)};
}

export function taskSteps(task) {
  if (task.mode === 'export') return ['导出视频'];
  if (task.mode === 'narration') return ['生成配音', '制作配音网页'];
  if (task.delivery === 'lesson' && getCapability(task.capability).kind !== 'interactive')
    return ['识别题目', '解题与复核', '制作讲解网页'];
  return getCapability(task.capability).kind === 'interactive'
    ? ['读取题目', '解题与复核', '制作交互讲解']
    : ['识别题目', '解题与复核', '生成配音', '制作视频'];
}

// Older tasks contain only an MP4 URL. Keep them playable while the new
// interactive format uses a separate, sandboxed HTML preview.
export function resultFormat(task) {
  if (['lesson', 'interactive', 'video'].includes(task.result?.format)) return task.result.format;
  if (task.result?.video) return 'video';
  return getCapability(task.capability).kind;
}

// Explicit false distinguishes a silent lesson from older video previews that
// predate audioReady. Old MP4-only tasks continue to count as narrated.
export function hasNarration(task) {
  if (typeof task.result?.audioReady === 'boolean') return task.result.audioReady;
  return resultFormat(task) === 'video';
}

export function resultActions(task) {
  const narrated = hasNarration(task);
  return {
    narrate: task.status === 'completed' && !!task.result && !narrated,
    exportVideo: task.status === 'completed' && !!task.result && narrated && !task.result.video,
  };
}

export function projectBudgetText(budget) {
  if (!budget || !['limitCents', 'reservedCents', 'remainingCents'].every(key => Number.isFinite(budget[key]))) return '';
  const yuan = cents => (Math.max(0, cents) / 100).toFixed(2);
  return `项目累计预留 ¥${yuan(budget.reservedCents)} / ¥${yuan(budget.limitCents)}，可预留 ¥${yuan(budget.remainingCents)}。预留用于控制应用准入，不代表供应商实际账单。`;
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
