/** 响应结论 */
export type ResponseVerdict = '合格' | '不合格' | '待判定';

export const RESPONSE_VERDICTS: ResponseVerdict[] = ['合格', '不合格', '待判定'];

/**
 * 生效口径状态（台网中心侧对单份结论的溯源重算结果）。
 * - 原值有效：所用标准器在校准有效期内，生效值＝原始读数（修正因子通常为 1）。
 * - 已折算：标准器已过期/当日无有效证书，但可依证书修正因子另算生效值，原值留档。
 * - 待重算：标准器过期且无法折算（缺标准器号 / 缺可用证书），结论暂不纳入合格率与更换口径。
 * - 重算失败：最近一次重算报错，仅允许重试这一份。
 */
export type EffectStatus = '原值有效' | '已折算' | '待重算' | '重算失败';

export const EFFECT_STATUSES: EffectStatus[] = ['原值有效', '已折算', '待重算', '重算失败'];

/** 一条生效值结论的判定依据（随标定一起持久化，供导出与审计） */
export interface EffectBasis {
  /** 依据的标准器编号（冗余存一份，标准器台账变动后仍可追溯） */
  standardSerialNo: string;
  /** 依据的溯源证书号 */
  certNo: string;
  /** 校准确认日期 */
  certConfirmDate: string;
  /** 校准有效期止 */
  certValidUntil: string;
  /** 比对当日标准器校准是否在有效期内 */
  caliberValidAtCalibration: boolean;
  /** 使用的灵敏度修正因子 */
  correctionFactor: number;
  /** 口径说明文案 */
  reason: string;
}

/** 重算记账（台网中心重出失败后只重试这份，标准器台账不动） */
export interface RecomputeState {
  status: EffectStatus;
  /** 最近一次重算时间（ms） */
  recomputedAt: number;
  /** 最近一次失败原因 */
  lastError: string;
  /** 累计重算次数（含成功与失败） */
  attempts: number;
}

/** 标定：同一仪器可叠加多次标定记录 */
export interface Calibration {
  id: string;
  /** 被标定仪器 */
  instrumentId: string;
  /** 标定日期 */
  date: string;
  /** 灵敏度（V·s/m）—— 原始读数，留档不覆盖 */
  sensitivity: number;
  /** 自噪（m/s² 或 counts，按台网口径记录）—— 原始读数 */
  selfNoise: number;
  /** 脉冲响应结论 —— 原始结论，留档不覆盖 */
  responseVerdict: ResponseVerdict;
  /** 标定人 */
  operator: string;
  /** 标定机构 */
  agency: string;
  /** 备注 */
  remark: string;

  /* ---------------- 计量溯源挂接（计量站标准器 / 台网中心结论各管一段） ---------------- */

  /** 比对所用标准器 id（计量站台账主键）；旧数据可能为空，升级时按标定日期补挂 */
  standardId: string;
  /** 标准器出厂编号冗余（标准器删除后仍可读） */
  standardSerialNo: string;
  /** 溯源证书号冗余（记录“当时那台、那张证”） */
  traceCertNo: string;
  /** 生效灵敏度（原始读数 × 修正因子）；未算出时为 null */
  effectiveSensitivity: number | null;
  /** 生效自噪（随生效灵敏度同口径折算，未算出时为 null） */
  effectiveSelfNoise: number | null;
  /** 生效结论（合格率 / 更换提醒 / 导出统一用它）；待重算时为 待判定 */
  effectiveVerdict: ResponseVerdict;
  /** 生效口径状态 */
  effectStatus: EffectStatus;
  /** 生效值判定依据 */
  effectBasis: EffectBasis | null;
  /** 重算记账 */
  recompute: RecomputeState | null;

  createdAt: number;
  updatedAt: number;
}

/**
 * 自动初判：灵敏度落在合理区间且自噪不高于阈值判合格。
 * 阈值按台网常规口径给出，最终以标定报告为准。
 */
export const SENSITIVITY_RANGE: Record<string, { min: number; max: number }> = {
  宽频带: { min: 800, max: 3000 },
  短周期: { min: 100, max: 800 },
  强震: { min: 0.1, max: 5 }
};

export const SELF_NOISE_LIMIT = 3.5;

export function judgeCalibration(
  type: string,
  sensitivity: number,
  selfNoise: number
): ResponseVerdict {
  if (!Number.isFinite(sensitivity) || !Number.isFinite(selfNoise)) return '待判定';
  const range = SENSITIVITY_RANGE[type] ?? { min: 0, max: Number.MAX_SAFE_INTEGER };
  if (sensitivity < range.min || sensitivity > range.max) return '不合格';
  if (selfNoise > SELF_NOISE_LIMIT) return '不合格';
  return '合格';
}

/** 灵敏度变化量（相对上一次标定），返回绝对值与百分比 */
export interface SensitivityDelta {
  /** 本次 - 上次 */
  absolute: number;
  /** 变化百分比（%） */
  percent: number;
  /** 是否有上一次标定可比 */
  comparable: boolean;
}

export function sensitivityDelta(current: number, previous: number | null): SensitivityDelta {
  if (previous === null || !Number.isFinite(previous) || previous === 0) {
    return { absolute: 0, percent: 0, comparable: false };
  }
  const absolute = Number((current - previous).toFixed(2));
  return { absolute, percent: Number(((absolute / previous) * 100).toFixed(2)), comparable: true };
}

/** 标定页筛选条件（存于 calibrationSlice） */
export interface CalibrationFilterState {
  keyword: string;
  verdicts: ResponseVerdict[];
  instrumentTypes: string[];
  /** 生效口径状态筛选 */
  effectStatuses: EffectStatus[];
  /** 是否只看超期未标定仪器 */
  onlyOverdue: boolean;
  /** 统计口径：raw=原始结论（留档对照）；effective=生效结论（默认，合格率/提醒/导出口径） */
  verdictBasis: 'raw' | 'effective';
}

export function createEmptyCalibrationFilter(): CalibrationFilterState {
  return {
    keyword: '',
    verdicts: [],
    instrumentTypes: [],
    effectStatuses: [],
    onlyOverdue: false,
    verdictBasis: 'effective',
  };
}

/** 待标定天数文案：正数为剩余天数、负数为超期天数、0 为今日到期 */
export function calibrateDueText(dueInDays: number): string {
  if (!Number.isFinite(dueInDays)) return '标定日期缺失';
  if (dueInDays === 0) return '今日到期';
  if (dueInDays > 0) return `距下次标定 ${dueInDays} 天`;
  return `已超期 ${Math.abs(dueInDays)} 天`;
}

/** 未挂标准器 / 无法折算时的初始重算记账 */
export function createPendingRecompute(now: number, reason: string): RecomputeState {
  return { status: '待重算', recomputedAt: now, lastError: reason, attempts: 0 };
}

/** 生效结论是否纳入合格率 / 更换提醒口径（待重算与重算失败的先单列、不计入） */
export function isEffectUsable(status: EffectStatus): boolean {
  return status === '原值有效' || status === '已折算';
}

/** 生效口径状态对应的标签颜色 */
export const EFFECT_STATUS_COLOR: Record<EffectStatus, string> = {
  原值有效: 'green',
  已折算: 'blue',
  待重算: 'orange',
  重算失败: 'red',
};
