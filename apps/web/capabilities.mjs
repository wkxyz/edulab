// Shared by the browser and task service. These examples are built in, not an
// indication that live generation is enabled; /api/health controls live access.
export const DEFAULT_CAPABILITY = 'math-video';
export const DEFAULT_CAPABILITY_ID = DEFAULT_CAPABILITY;

const boards = ['chalk', 'lab', 'whiteboard', 'notebook'];
export const CAPABILITIES = [
  {
    id: 'solid-geometry', title: '立体几何', kind: 'interactive', subject: 'math',
    description: '旋转三维图形，跟着坐标与向量看懂空间关系。',
    sampleLabel: '正四棱锥中的线面角', sampleProblem: '正四棱锥 P-ABCD，底边长 2、高 1，E 为 PC 中点，求 BE 与平面 PAC 夹角的正弦。',
    random: true, styles: [],
  },
  {
    id: 'analytic-geometry', title: '解析几何', kind: 'interactive', subject: 'math',
    description: '拖动参数，观察圆锥曲线、直线与交点如何变化。',
    sampleLabel: '椭圆中的向量数量积', sampleProblem: '椭圆 x²/4 + y²/3 = 1，M(-1,0)，过右焦点 F(1,0) 的直线交椭圆于 A、B，求向量 MA·MB 的范围。',
    random: true, styles: [],
  },
  {
    id: 'chem-reaction', title: '化学反应', kind: 'interactive', subject: 'chemistry',
    description: '从微观粒子观察反应过程，核对原子守恒与配平。',
    sampleLabel: '甲烷燃烧与原子守恒', sampleProblem: 'CH₄ + 2O₂ → CO₂ + 2H₂O，观察甲烷燃烧前后原子的重新组合。',
    random: true, styles: [],
  },
  {
    id: 'math-video', title: '数学视频', kind: 'video', subject: 'math',
    description: '用动态板书和语音，分步讲清数学题的解法。',
    sampleLabel: '一元一次方程', sampleProblem: '2x + 3 = 11',
    random: false, styles: [...boards, 'handdrawn'],
  },
  {
    id: 'physics-video', title: '物理视频', kind: 'video', subject: 'physics',
    description: '结合示意图与语音，讲清物理模型、公式和推导。',
    sampleLabel: '牛顿第二定律与位移', sampleProblem: '质量 2 千克的物体受到 6 牛的水平合力，从静止运动 2 秒，求加速度和位移。',
    random: false, styles: ['chalk'],
  },
  {
    id: 'chem-video', title: '化学视频', kind: 'video', subject: 'chemistry',
    description: '结合反应式与板书，分步讲解化学计算和反应规律。',
    sampleLabel: '甲烷燃烧反应的配平', sampleProblem: '配平甲烷燃烧反应，并说明反应前后各元素的原子如何守恒。',
    random: false, styles: ['chalk'],
  },
];

export function getCapability(id = DEFAULT_CAPABILITY) {
  return CAPABILITIES.find(capability => capability.id === id) || CAPABILITIES.find(capability => capability.id === DEFAULT_CAPABILITY);
}
