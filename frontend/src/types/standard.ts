/**
 * 计量标准器（计量站侧台账）与溯源证书。
 *
 * 职责边界（计量站管）：
 * - 标准器本身（型号 / 编号 / 建标机构 / 状态）；
 * - 校准有效期（由每张溯源证书的 validFrom ~ validUntil 表达）；
 * - 溯源证书（证书号、确认日期、有效期、灵敏度修正因子、不确定度）。
 *
 * 台网中心侧（标定记录、响应结论、更换提醒）只“引用”标准器 id，
 * 不允许修改本表；标准器一旦过校准有效期，台网侧对挂接它的结论另算生效值。
 */

/** 标准器状态：在役 / 停用（停用后不再承接新标定，历史挂接仍可重算） */
export type StandardState = '在役' | '停用';
export const STANDARD_STATES: StandardState[] = ['在役', '停用'];

/** 标准器适用的仪器类型（与 InstrumentType 对齐，用字符串避免跨域强耦合） */
export const STANDARD_SCOPE_TYPES: string[] = ['宽频带', '短周期', '强震'];

/** 溯源证书：一次上级计量机构对标准器的校准/确认 */
export interface TraceCertificate {
  /** 证书编号 */
  certNo: string;
  /** 溯源到的上级计量机构 */
  issuedBy: string;
  /** 校准确认日期（YYYY-MM-DD） */
  confirmDate: string;
  /** 校准有效期起（通常等于 confirmDate） */
  validFrom: string;
  /** 校准有效期止（YYYY-MM-DD，含当日） */
  validUntil: string;
  /** 灵敏度修正因子：生效灵敏度 = 原始读数 × 修正因子 */
  correctionFactor: number;
  /** 扩展不确定度（%），仅留档展示，不参与判定 */
  uncertaintyPct: number;
  /** 备注（如溯源链、标准装置名称） */
  remark: string;
}

/** 计量标准器：用于与台站仪器比对手持/现场标定的计量标准 */
export interface CalibrationStandard {
  id: string;
  /** 标准器名称，如「便携式地震计校准装置」 */
  name: string;
  /** 标准器型号 */
  model: string;
  /** 标准器出厂编号（台网点名要挂的“当时那台”） */
  serialNo: string;
  /** 建标 / 保管机构（计量站） */
  ownerAgency: string;
  /** 适用仪器类型（可跨类型则多选） */
  scopeTypes: string[];
  /** 启用日期（YYYY-MM-DD）：早于该日期的标定不能挂这台 */
  inUseFrom: string;
  /** 停用日期（YYYY-MM-DD），在役时为空串 */
  inUseUntil: string;
  state: StandardState;
  /** 溯源证书（按确认日期升序保存） */
  certificates: TraceCertificate[];
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 标准器表单草稿 */
export interface StandardDraft {
  name: string;
  model: string;
  serialNo: string;
  ownerAgency: string;
  scopeTypes: string[];
  inUseFrom: string;
  inUseUntil: string;
  state: StandardState;
  remark: string;
}

export function createEmptyStandardDraft(): StandardDraft {
  return {
    name: '',
    model: '',
    serialNo: '',
    ownerAgency: '',
    scopeTypes: ['宽频带'],
    inUseFrom: new Date().toISOString().slice(0, 10),
    inUseUntil: '',
    state: '在役',
    remark: '',
  };
}

/** 标准器在某日期是否处于其设备在用区间（与校准有效期是两回事） */
export function isStandardInService(standard: CalibrationStandard, date: string): boolean {
  if (date < standard.inUseFrom) return false;
  if (standard.state === '停用' && standard.inUseUntil && date > standard.inUseUntil) return false;
  return true;
}

/** 取标准器在指定日期“生效”的那张溯源证书（在有效期窗口内） */
export function certificateAt(
  standard: CalibrationStandard,
  date: string
): TraceCertificate | null {
  const hit = standard.certificates.find(
    (cert) => date >= cert.validFrom && date <= cert.validUntil
  );
  return hit ?? null;
}

/** 标准器在指定日期的校准状态（判定“标准器一过期”用） */
export type CaliberStatus = '有效' | '过期' | '未建标' | '停用';

export function caliberStatusAt(standard: CalibrationStandard | null | undefined, date: string): CaliberStatus {
  if (!standard) return '未建标';
  if (!isStandardInService(standard, date)) return '停用';
  if (certificateAt(standard, date)) return '有效';
  return '过期';
}

/** 标准器当前（今天）是否处于校准有效期内，用于台账高亮与到期提醒 */
export function standardCurrentStatus(
  standard: CalibrationStandard,
  today: string
): { status: CaliberStatus; cert: TraceCertificate | null; daysToExpiry: number | null } {
  if (standard.state === '停用') {
    return { status: '停用', cert: null, daysToExpiry: null };
  }
  const cert = certificateAt(standard, today);
  if (cert) {
    const days = Math.round(
      (Date.parse(`${cert.validUntil}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86400000
    );
    return { status: '有效', cert, daysToExpiry: days };
  }
  return { status: '过期', cert: null, daysToExpiry: null };
}
