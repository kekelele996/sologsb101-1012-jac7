/**
 * 计量溯源与生效值核心域（纯函数）。
 *
 * 职责边界：
 * - 计量站（CalibrationStandard + TraceCertificate）：标准器、校准有效期、溯源证书；
 * - 台网中心（Calibration 生效值）：标定记录、响应结论、更换提醒。
 *
 * 口径决策（需求中“这里你定”）：
 *   采用「原值留档 + 另算生效值并标出依据」，不推倒重测。
 *   - 比对当日标准器在校准有效期内：生效值＝原始读数，状态「原值有效」；
 *   - 标准器已过期（当日无有效证书）但能找到其最近一张证书的修正因子：
 *     生效值＝原始读数 × 修正因子，并在依据里标明“标准器过期、按证书 XX 折算”，状态「已折算」；
 *   - 挂不出标准器或没有任何证书可折算：状态「待重算」，结论先单列，不进合格率/更换口径；
 *   - 折算过程出错：状态「重算失败」，只重试这一份，标准器台账不动。
 */
import type { CalibrationStandard, TraceCertificate } from '@/types/standard';
import { certificateAt, isStandardInService } from '@/types/standard';
import {
  judgeCalibration,
  type Calibration,
  type EffectBasis,
  type EffectStatus,
  type RecomputeState,
  type ResponseVerdict,
} from '@/types/calibration';

/** 生效值折算结果 */
export interface EffectResult {
  status: EffectStatus;
  effectiveSensitivity: number | null;
  effectiveSelfNoise: number | null;
  effectiveVerdict: ResponseVerdict;
  basis: EffectBasis | null;
  error: string;
}

/** 取标准器“最近一张”证书（按有效期止降序）；过期折算时用它的修正因子 */
export function latestCertificate(standard: CalibrationStandard): TraceCertificate | null {
  if (standard.certificates.length === 0) return null;
  return [...standard.certificates].sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0];
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * 由一条标定记录 + 标准器台账，重新折算单份生效值。
 * 不抛异常：失败折叠为 重算失败 / 待重算，供“只重试这份”。
 */
export function computeEffect(
  calibration: Pick<Calibration, 'date' | 'sensitivity' | 'selfNoise' | 'instrumentId'> & {
    instrumentType?: string;
  },
  standard: CalibrationStandard | null,
  attempt: number,
  now: number
): EffectResult & { recompute: RecomputeState } {
  const fail = (status: EffectStatus, error: string, basis: EffectBasis | null = null): EffectResult & {
    recompute: RecomputeState;
  } => ({
    status,
    effectiveSensitivity: null,
    effectiveSelfNoise: null,
    effectiveVerdict: '待判定',
    basis,
    error,
    recompute: { status, recomputedAt: now, lastError: error, attempts: attempt + 1 },
  });

  if (!standard) {
    return fail('待重算', '旧数据未挂标准器号，按标定日期补不到当时在用的标准器，先单列待补挂');
  }
  if (!isStandardInService(standard, calibration.date)) {
    return fail('待重算', `标准器 ${standard.serialNo} 在标定日 ${calibration.date} 不处于在用区间`);
  }

  const validCert = certificateAt(standard, calibration.date);
  const latestCert = latestCertificate(standard);

  if (!validCert && latestCert === null) {
    return fail('待重算', `标准器 ${standard.serialNo} 无任何溯源证书，无法折算生效值`);
  }
  // 有效期内：原值即生效值（修正因子视为 1，仅当“过期后另算”时才启用最近证书的修正因子）。
  // 标准器过期后：保留原值，按最近一张证书的修正因子折算生效值并标出依据。
  const cert = validCert ?? latestCert!;
  const rawFactor = cert.correctionFactor;
  if (typeof rawFactor !== 'number' || !Number.isFinite(rawFactor) || rawFactor <= 0) {
    return fail('重算失败', `标准器 ${standard.serialNo} 的修正因子非法，无法折算（仅本份失败，标准器台账未改动）`);
  }
  const factor = validCert ? 1 : rawFactor;

  const effectiveSensitivity = round2(calibration.sensitivity * factor);
  const effectiveSelfNoise = round2(calibration.selfNoise * factor);
  const effectiveVerdict = judgeCalibration(
    calibration.instrumentType ?? '宽频带',
    effectiveSensitivity,
    effectiveSelfNoise
  );

  const basis: EffectBasis = {
    standardSerialNo: standard.serialNo,
    certNo: cert.certNo,
    certConfirmDate: cert.confirmDate,
    certValidUntil: cert.validUntil,
    caliberValidAtCalibration: Boolean(validCert),
    correctionFactor: factor,
    reason: validCert
      ? `比对当日标准器 ${standard.serialNo} 持有效证书 ${cert.certNo}（有效期至 ${cert.validUntil}），原值即为生效值`
      : `标准器 ${standard.serialNo} 在标定日已过校准有效期（最近证书 ${cert.certNo}，有效期至 ${cert.validUntil}），原值留档，按修正因子 ${rawFactor} 折算生效值`,
  };

  const status: EffectStatus = validCert ? '原值有效' : '已折算';
  return {
    status,
    effectiveSensitivity,
    effectiveSelfNoise,
    effectiveVerdict,
    basis,
    error: '',
    recompute: { status, recomputedAt: now, lastError: '', attempts: attempt + 1 },
  };
}

/**
 * 按标定日期补挂“当时在用”的那台标准器（旧数据升级用）。
 * 规则：设备在用区间覆盖标定日、适用类型匹配，且优先选当日校准有效的；
 * 多台命中时取启用日期最晚的一台。补不出返回 null（先单列）。
 */
export function pickStandardAtDate(
  standards: CalibrationStandard[],
  date: string,
  instrumentType: string
): CalibrationStandard | null {
  const candidates = standards.filter(
    (standard) =>
      isStandardInService(standard, date) &&
      (standard.scopeTypes.length === 0 || standard.scopeTypes.includes(instrumentType))
  );
  if (candidates.length === 0) return null;
  const withValid = candidates.filter((standard) => certificateAt(standard, date) !== null);
  const pool = withValid.length > 0 ? withValid : candidates;
  return [...pool].sort((a, b) => b.inUseFrom.localeCompare(a.inUseFrom))[0];
}

/** 重算单份标定所需的最小入参（从 Redux 组装，避免页面直接碰库） */
export function recomputeCalibrationEffect(
  calibration: Calibration,
  standard: CalibrationStandard | null,
  instrumentType: string,
  now: number
): EffectResult & { recompute: RecomputeState } {
  return computeEffect(
    {
      date: calibration.date,
      sensitivity: calibration.sensitivity,
      selfNoise: calibration.selfNoise,
      instrumentId: calibration.instrumentId,
      instrumentType,
    },
    standard,
    calibration.recompute?.attempts ?? 0,
    now
  );
}
