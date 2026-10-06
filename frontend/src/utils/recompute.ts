/**
 * 台网中心侧：标定结论生效值重算服务。
 *
 * 边界：只写 calibrations 表的生效值字段与重算记账；
 * 标准器台账（standards 表）只读，重算成功与否都不改动它。
 * 标准器一旦过期 / 补挂 / 修正因子更新，调用对应方法让挂接它的结论“重算一版”。
 */
import { db } from '@/utils/db';
import type { Calibration } from '@/types/calibration';
import type { CalibrationStandard } from '@/types/standard';
import { recomputeCalibrationEffect } from '@/utils/traceability';

export interface RecomputeReport {
  total: number;
  recomputed: number;
  usable: number;
  pending: number;
  failed: number;
}

function applyEffect(row: Calibration, effect: ReturnType<typeof recomputeCalibrationEffect>): void {
  row.effectiveSensitivity = effect.effectiveSensitivity;
  row.effectiveSelfNoise = effect.effectiveSelfNoise;
  row.effectiveVerdict = effect.effectiveVerdict;
  row.effectStatus = effect.status;
  row.effectBasis = effect.basis;
  row.recompute = effect.recompute;
  row.standardSerialNo = effect.basis?.standardSerialNo ?? row.standardSerialNo;
  row.traceCertNo = effect.basis?.certNo ?? '';
  row.updatedAt = Date.now();
}

/**
 * 重算单份标定（“台网中心重出失败后只重试这份”）。
 * 成功与否都只动这一行，标准器台账不变。
 */
export async function recomputeOne(calibrationId: string): Promise<Calibration> {
  return db.transaction('rw', [db.calibrations, db.instruments, db.standards], async () => {
    const calibration = await db.calibrations.get(calibrationId);
    if (!calibration) throw new Error('标定记录不存在');
    const instrument = await db.instruments.get(calibration.instrumentId);
    const standard = calibration.standardId
      ? await db.standards.get(calibration.standardId)
      : undefined;
    const effect = recomputeCalibrationEffect(
      calibration,
      standard ?? null,
      instrument?.type ?? '宽频带',
      Date.now()
    );
    await db.calibrations.update(calibrationId, {
      effectiveSensitivity: effect.effectiveSensitivity,
      effectiveSelfNoise: effect.effectiveSelfNoise,
      effectiveVerdict: effect.effectiveVerdict,
      effectStatus: effect.status,
      effectBasis: effect.basis,
      recompute: effect.recompute,
      standardSerialNo: effect.basis?.standardSerialNo ?? calibration.standardSerialNo,
      traceCertNo: effect.basis?.certNo ?? '',
      updatedAt: Date.now(),
    } as never);
    return (await db.calibrations.get(calibrationId))!;
  });
}

/**
 * 全量重算：用于打开库后补算迁移数据、以及“一键按新口径重出”。
 * 只处理需要处理的行（待重算 / 重算失败，或传入 force=true 全量）。
 */
export async function recomputeAll(options?: {
  force?: boolean;
  standardsOverride?: CalibrationStandard[];
}): Promise<RecomputeReport> {
  const force = options?.force ?? false;
  return db.transaction('rw', [db.calibrations, db.instruments, db.standards], async () => {
    const standards = options?.standardsOverride ?? (await db.standards.toArray());
    const instruments = await db.instruments.toArray();
    const typeMap = new Map(instruments.map((row) => [row.id, row.type]));
    const standardMap = new Map(standards.map((row) => [row.id, row]));

    const rows = await db.calibrations.toArray();
    const changed: Calibration[] = [];
    let recomputed = 0;
    let usable = 0;
    let pending = 0;
    let failed = 0;

    for (const row of rows) {
      const need = force || row.effectStatus === '待重算' || row.effectStatus === '重算失败';
      if (!need) {
        if (row.effectStatus === '原值有效' || row.effectStatus === '已折算') usable += 1;
        continue;
      }
      const standard = row.standardId ? standardMap.get(row.standardId) ?? null : null;
      const effect = recomputeCalibrationEffect(
        row,
        standard,
        typeMap.get(row.instrumentId) ?? '宽频带',
        Date.now()
      );
      applyEffect(row, effect);
      changed.push(row);
      recomputed += 1;
      if (effect.status === '原值有效' || effect.status === '已折算') usable += 1;
      else if (effect.status === '重算失败') failed += 1;
      else pending += 1;
    }

    if (changed.length > 0) await db.calibrations.bulkPut(changed);
    return { total: rows.length, recomputed, usable, pending, failed };
  });
}

/**
 * 标准器变更（续证 / 修正因子更新 / 补挂）后，让挂接它的全部结论重算一版。
 * 仅重算引用该标准器的标定；标准器台账本身由此方法的调用方（计量站页）负责保存。
 */
export async function recomputeByStandard(standardId: string): Promise<number> {
  return db.transaction('rw', [db.calibrations, db.instruments, db.standards], async () => {
    const standard = await db.standards.get(standardId);
    if (!standard) return 0;
    const instruments = await db.instruments.toArray();
    const typeMap = new Map(instruments.map((row) => [row.id, row.type]));
    const rows = await db.calibrations.where('standardId').equals(standardId).toArray();
    for (const row of rows) {
      const effect = recomputeCalibrationEffect(
        row,
        standard,
        typeMap.get(row.instrumentId) ?? '宽频带',
        Date.now()
      );
      applyEffect(row, effect);
    }
    if (rows.length > 0) await db.calibrations.bulkPut(rows);
    return rows.length;
  });
}

/**
 * 旧数据补挂标准器后重算这批标定：给指定标定写入 standardId 并重算。
 * 返回实际重算条数。
 */
export async function attachStandardAndRecompute(
  calibrationIds: string[],
  standardId: string
): Promise<number> {
  return db.transaction('rw', [db.calibrations, db.instruments, db.standards], async () => {
    const standard = await db.standards.get(standardId);
    if (!standard) throw new Error('所选标准器不存在');
    const instruments = await db.instruments.toArray();
    const typeMap = new Map(instruments.map((row) => [row.id, row.type]));
    const rows = await db.calibrations.where('id').anyOf(calibrationIds).toArray();
    for (const row of rows) {
      row.standardId = standardId;
      const effect = recomputeCalibrationEffect(
        row,
        standard,
        typeMap.get(row.instrumentId) ?? '宽频带',
        Date.now()
      );
      applyEffect(row, effect);
    }
    if (rows.length > 0) await db.calibrations.bulkPut(rows);
    return rows.length;
  });
}
