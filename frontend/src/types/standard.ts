/**
 * 标准器（计量站管辖）：标定台站仪器响应结论时比对的计量标准器。
 * 标准器有校准有效期，过期后比过的结论需重算生效值。
 */
import type { Calibration, EffectiveVerdict } from '@/types/calibration';

export { EFFECTIVE_VERDICTS } from '@/types/calibration';

/** 标准器台账行 */
export interface Standard {
  id: string;
  /** 标准器名称 */
  name: string;
  /** 型号 */
  model: string;
  /** 序列号 */
  serialNo: string;
  /** 溯源证书号 */
  certificateNo: string;
  /** 校准日期 */
  calibrationDate: string;
  /** 有效期至 */
  validUntil: string;
  /** 计量机构 */
  agency: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 标准器登记草稿（存于 standardSlice） */
export interface StandardDraft {
  name: string;
  model: string;
  serialNo: string;
  certificateNo: string;
  calibrationDate: string;
  validUntil: string;
  agency: string;
  remark: string;
}

export function createEmptyStandardDraft(): StandardDraft {
  return {
    name: '',
    model: '',
    serialNo: '',
    certificateNo: '',
    calibrationDate: new Date().toISOString().slice(0, 10),
    validUntil: '',
    agency: '',
    remark: '',
  };
}

/** 生效结论计算结果 */
export interface EffectiveVerdictInfo {
  /** 生效结论 */
  verdict: EffectiveVerdict;
  /** 依据说明 */
  basis: string;
  /** 挂接的标准器 id（未挂接为 null） */
  standardId: string | null;
  /** 标准器名称（未挂接为空） */
  standardName: string;
  /** 标定时标准器是否在有效期内 */
  standardValid: boolean;
}

/** 标准器是否在指定日期有效 */
export function isStandardValidOn(standard: Standard, date: string): boolean {
  const t = Date.parse(`${date}T00:00:00`);
  const cal = Date.parse(`${standard.calibrationDate}T00:00:00`);
  const until = Date.parse(`${standard.validUntil}T00:00:00`);
  if (!Number.isFinite(t) || !Number.isFinite(cal) || !Number.isFinite(until)) return false;
  return t >= cal && t <= until;
}

/** 标准器当前是否已过期（以今天为基准） */
export function isStandardExpired(standard: Standard, now: number = Date.now()): boolean {
  const until = Date.parse(`${standard.validUntil}T00:00:00`);
  if (!Number.isFinite(until)) return false;
  return until < now;
}

/** 距标准器过期天数：正数为剩余天数，负数为已过期天数 */
export function standardExpireInDays(standard: Standard, now: number = Date.now()): number {
  const until = Date.parse(`${standard.validUntil}T00:00:00`);
  if (!Number.isFinite(until)) return Number.NaN;
  return Math.round((until - now) / 86400000);
}

/**
 * 计算标定记录的生效结论：
 * - 未挂标准器 → 待判定，依据「未挂标准器，结论无有效依据」
 * - 挂了标准器但标定时已过期 → 依据失效
 * - 标准器在有效期内 → 维持原响应结论
 */
export function computeEffectiveVerdict(
  calibration: Calibration,
  standard: Standard | null | undefined
): EffectiveVerdictInfo {
  if (!calibration.standardId || !standard) {
    return {
      verdict: '待判定',
      basis: '未挂标准器，结论无有效依据',
      standardId: null,
      standardName: '',
      standardValid: false,
    };
  }
  const calTime = Date.parse(`${calibration.date}T00:00:00`);
  const untilTime = Date.parse(`${standard.validUntil}T00:00:00`);
  if (Number.isFinite(calTime) && Number.isFinite(untilTime) && calTime > untilTime) {
    return {
      verdict: '依据失效',
      basis: `标定时（${calibration.date}）标准器「${standard.name}」已过期（有效期至 ${standard.validUntil}）`,
      standardId: standard.id,
      standardName: standard.name,
      standardValid: false,
    };
  }
  return {
    verdict: calibration.responseVerdict,
    basis: `依据标准器「${standard.name}」（证书号 ${standard.certificateNo || '未填'}）`,
    standardId: standard.id,
    standardName: standard.name,
    standardValid: true,
  };
}

/**
 * 按标定日期回填当时在用的标准器：
 * 找校准日期 <= 标定日期 <= 有效期至 的标准器；若有多台，取校准日期最新的一台。
 * 找不到返回 null（调用方单列）。
 */
export function backfillStandardId(calibration: Calibration, standards: Standard[]): string | null {
  const candidates = standards
    .filter((standard) => isStandardValidOn(standard, calibration.date))
    .sort((a, b) => b.calibrationDate.localeCompare(a.calibrationDate));
  return candidates.length > 0 ? candidates[0].id : null;
}

/** 生效结论统计 */
export function effectiveVerdictCounts(
  infos: Array<{ verdict: EffectiveVerdict }>
): Record<EffectiveVerdict, number> {
  const counts: Record<EffectiveVerdict, number> = {
    合格: 0,
    不合格: 0,
    待判定: 0,
    依据失效: 0,
  };
  infos.forEach((info) => {
    counts[info.verdict] += 1;
  });
  return counts;
}
