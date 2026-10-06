/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbseisarray，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（台阵 → 台站 → 仪器 → 标定 / 更换）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument } from '@/types/instrument';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration } from '@/types/calibration';
import type { Replace } from '@/types/replace';
import type { CalibrationStandard } from '@/types/standard';
import { pickStandardAtDate, recomputeCalibrationEffect } from '@/utils/traceability';

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3;

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbseisarray';

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbseisarray:db-version',
  lastBackupAt: 'gbseisarray:last-backup-at',
  lastArrayId: 'gbseisarray:last-array-id',
} as const;

/** 备份文件结构，供 utils/export.ts 与几何页使用 */
export interface BackupPayload {
  app: 'gbseisarray';
  dbVersion: number;
  exportedAt: string;
  arrays: SeisArray[];
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
  replaces: Replace[];
  standards: CalibrationStandard[];
}

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  instruments!: Table<Instrument, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;
  /** 计量站标准器台账（含溯源证书） */
  standards!: Table<CalibrationStandard, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      arrays: 'id, name, state',
      stations: 'id, arrayId, code',
      instruments: 'id, stationId, serialNo, state',
      calibrations: 'id, instrumentId, date',
      replaces: 'id, instrumentId, state',
    });

    // v2：补齐筛选与统计需要的索引（孔径/布设日期、经纬度/基岩、类型/序列号、灵敏度/结论、原因）
    this.version(2).stores({
      arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
      stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
      instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
      calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
      replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
    });

    // v3：计量溯源域——新增 standards 表；标定挂标准器并按生效口径索引
    this.version(DB_VERSION)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
        calibrations:
          'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, standardId, standardSerialNo, traceCertNo, effectStatus, effectiveVerdict, updatedAt',
        replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
        standards: 'id, name, model, serialNo, state, ownerAgency, updatedAt',
      })
      .upgrade(async (tx) => {
        // v2 → v3：旧标定缺标准器号，按标定日期补“当时在用”的那台；补不出先单列（待重算）。
        const standards = await tx.table<CalibrationStandard, string>('standards').toArray();
        const instruments = await tx.table<Instrument, string>('instruments').toArray();
        const instrumentType = new Map(instruments.map((row) => [row.id, row.type]));

        await tx
          .table<Calibration, string>('calibrations')
          .toCollection()
          .modify((row) => {
            const now = Date.now();
            const type = instrumentType.get(row.instrumentId) ?? '宽频带';

            // 历史行可能连 v2 默认字段都缺，先兜底
            if (typeof row.sensitivity !== 'number') row.sensitivity = 0;
            if (typeof row.selfNoise !== 'number') row.selfNoise = 0;
            if (!row.responseVerdict) row.responseVerdict = '待判定';
            if (typeof row.agency !== 'string') row.agency = '';

            if (typeof row.standardId !== 'string') {
              const matched = standards.length > 0 ? pickStandardAtDate(standards, row.date, type) : null;
              row.standardId = matched?.id ?? '';
              row.standardSerialNo = matched?.serialNo ?? '';
              row.traceCertNo = '';
            }
            if (row.effectiveSensitivity === undefined) row.effectiveSensitivity = null;
            if (row.effectiveSelfNoise === undefined) row.effectiveSelfNoise = null;
            if (!row.effectiveVerdict) row.effectiveVerdict = '待判定';
            if (!row.effectStatus) {
              // 迁移此刻不做整库折算（避免在升级事务里跑重逻辑）：先标记，由打开后的重算任务按份补算
              row.effectStatus = row.standardId ? '原值有效' : '待重算';
            }
            if (row.effectBasis === undefined) row.effectBasis = null;
            if (row.recompute === undefined) {
              row.recompute = row.standardId
                ? null
                : {
                    status: '待重算' as const,
                    recomputedAt: now,
                    lastError: '旧数据未记标准器号，升级时按标定日期补不到当时在用的标准器，先单列待补挂',
                    attempts: 0,
                  };
            }
          });
      });
  }
}

export const db = new SeisArrayDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 订阅单表变化（Dexie liveQuery），返回取消订阅函数 */
export function watchTable<T>(
  table: () => Table<T, string>
): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray());
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([]),
      });
      return () => subscription.unsubscribe();
    },
  };
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCalibration {
  id: string;
  instrumentId: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
  remark: string;
}

interface SeedInstrument {
  id: string;
  stationId: string;
  type: Instrument['type'];
  model: string;
  serialNo: string;
  installDate: string;
  state: Instrument['state'];
  remark: string;
  calibrations: SeedCalibration[];
}

interface SeedStation {
  id: string;
  arrayId: string;
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: SeisStation['bedrock'];
  siteNote: string;
  instruments: SeedInstrument[];
}

interface SeedArray {
  id: string;
  name: string;
  apertureKm: number;
  deployDate: string;
  state: SeisArray['state'];
  department: string;
  stations: SeedStation[];
}

/**
 * 播种演示数据：2 个台阵 → 5 个台站 → 8 台仪器 → 14 条标定 + 3 条更换，
 * 覆盖「在用 / 待标定 / 已停用」与「合格 / 不合格」以及超期未标定样本。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const daysAgo = (days: number): string => new Date(now - days * 86400000).toISOString().slice(0, 10);

  const arrays: SeedArray[] = [
    {
      id: 'arr_ltx',
      name: '龙门峡流动台阵',
      apertureKm: 24.6,
      deployDate: '2021-04-18',
      state: '运行中',
      department: '省地震局监测中心',
      stations: [
        {
          id: 'stn_ltx_01',
          arrayId: 'arr_ltx',
          code: 'LTX01',
          lat: 30.8421,
          lng: 103.5624,
          elevM: 1180,
          bedrock: '花岗岩',
          siteNote: '基岩出露，噪声本底低',
          instruments: [
            {
              id: 'ins_ltx01_bb',
              stationId: 'stn_ltx_01',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20210418-01',
              installDate: '2021-04-18',
              state: '在用',
              remark: '主用宽频带，配 24 位采集器',
              calibrations: [
                {
                  id: 'cal_ltx01_bb_1',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2023-04-20',
                  sensitivity: 1502.4,
                  selfNoise: 1.82,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '响应曲线平滑',
                },
                {
                  id: 'cal_ltx01_bb_2',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2024-04-12',
                  sensitivity: 1468.9,
                  selfNoise: 1.95,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '灵敏度略降 2.2%，仍在限内',
                },
              ],
            },
            {
              id: 'ins_ltx01_st',
              stationId: 'stn_ltx_01',
              type: '短周期',
              model: 'FSS-3B',
              serialNo: 'FSS3B-20210418-02',
              installDate: '2021-04-18',
              state: '待标定',
              remark: '备份仪器，已逾标定周期',
              calibrations: [
                {
                  id: 'cal_ltx01_st_1',
                  instrumentId: 'ins_ltx01_st',
                  date: '2022-05-06',
                  sensitivity: 412.6,
                  selfNoise: 2.4,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '首次标定',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_02',
          arrayId: 'arr_ltx',
          code: 'LTX02',
          lat: 30.9187,
          lng: 103.6412,
          elevM: 1425,
          bedrock: '玄武岩',
          siteNote: '半山台基，交通便利',
          instruments: [
            {
              id: 'ins_ltx02_bb',
              stationId: 'stn_ltx_02',
              type: '宽频带',
              model: 'Trillium-120',
              serialNo: 'T120-20220315-07',
              installDate: '2022-03-15',
              state: '在用',
              remark: '井下安装，深度 42 m',
              calibrations: [
                {
                  id: 'cal_ltx02_bb_1',
                  instrumentId: 'ins_ltx02_bb',
                  date: '2024-03-18',
                  sensitivity: 1204.8,
                  selfNoise: 1.42,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '响应一致性良好',
                },
              ],
            },
            {
              id: 'ins_ltx02_st',
              stationId: 'stn_ltx_02',
              type: '短周期',
              model: 'L-4C-3D',
              serialNo: 'L4C-20220315-08',
              installDate: '2022-03-15',
              state: '已停用',
              remark: '2024 年雷击损坏，已提交更换',
              calibrations: [
                {
                  id: 'cal_ltx02_st_1',
                  instrumentId: 'ins_ltx02_st',
                  date: '2023-03-10',
                  sensitivity: 265.2,
                  selfNoise: 4.8,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '自噪超标，判定不合格',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_03',
          arrayId: 'arr_ltx',
          code: 'LTX03',
          lat: 30.7802,
          lng: 103.4987,
          elevM: 986,
          bedrock: '石灰岩',
          siteNote: '河谷阶地，需注意汛期供电',
          instruments: [
            {
              id: 'ins_ltx03_bb',
              stationId: 'stn_ltx_03',
              type: '宽频带',
              model: 'STS-2.5',
              serialNo: 'STS25-20230902-11',
              installDate: '2023-09-02',
              state: '在用',
              remark: '新建站首台仪器',
              calibrations: [
                {
                  id: 'cal_ltx03_bb_1',
                  instrumentId: 'ins_ltx03_bb',
                  date: '2024-09-05',
                  sensitivity: 2251.3,
                  selfNoise: 2.05,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '脉冲响应合格',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'arr_hx',
      name: '海西宽频带台阵',
      apertureKm: 46.2,
      deployDate: '2019-09-25',
      state: '运行中',
      department: '国家测震台网中心',
      stations: [
        {
          id: 'stn_hx_01',
          arrayId: 'arr_hx',
          code: 'HX01',
          lat: 25.4321,
          lng: 119.3421,
          elevM: 62,
          bedrock: '花岗岩',
          siteNote: '海岛台，防盐雾处理',
          instruments: [
            {
              id: 'ins_hx01_bb',
              stationId: 'stn_hx_01',
              type: '宽频带',
              model: 'Trillium-Compact',
              serialNo: 'TC-20190925-03',
              installDate: '2019-09-25',
              state: '在用',
              remark: '海岛主用观测设备',
              calibrations: [
                {
                  id: 'cal_hx01_bb_1',
                  instrumentId: 'ins_hx01_bb',
                  date: '2023-09-28',
                  sensitivity: 1498.2,
                  selfNoise: 2.25,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '响应合格',
                },
                {
                  id: 'cal_hx01_bb_2',
                  instrumentId: 'ins_hx01_bb',
                  date: '2024-09-30',
                  sensitivity: 1483.6,
                  selfNoise: 2.42,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '变化 0.97%，合格',
                },
                {
                  // 最近一次标定晚于最新证书有效期（2025-07-01）：标准器已过期，原值留档、按 0.995 折算
                  id: 'cal_hx01_bb_3',
                  instrumentId: 'ins_hx01_bb',
                  date: daysAgo(40),
                  sensitivity: 1510.0,
                  selfNoise: 2.3,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '标准器超期未送检，结论按最近证书折算生效值',
                },
              ],
            },
            {
              id: 'ins_hx01_sm',
              stationId: 'stn_hx_01',
              type: '强震',
              model: 'ES-T',
              serialNo: 'EST-20190925-04',
              installDate: '2019-09-25',
              state: '在用',
              remark: '结构台阵强震观测',
              calibrations: [
                {
                  id: 'cal_hx01_sm_1',
                  instrumentId: 'ins_hx01_sm',
                  date: '2024-09-30',
                  sensitivity: 1.24,
                  selfNoise: 1.05,
                  operator: '周渝',
                  agency: '国家测震台网计量中心',
                  remark: '强震通道合格',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_hx_02',
          arrayId: 'arr_hx',
          code: 'HX02',
          lat: 25.2894,
          lng: 119.5112,
          elevM: 128,
          bedrock: '砂岩',
          siteNote: '覆盖层较厚，需做场地响应校正',
          instruments: [
            {
              id: 'ins_hx02_bb',
              stationId: 'stn_hx_02',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20190926-05',
              installDate: '2019-09-26',
              state: '待标定',
              remark: '夜间自噪抬升，待复标',
              calibrations: [
                {
                  id: 'cal_hx02_bb_1',
                  instrumentId: 'ins_hx02_bb',
                  date: '2023-06-11',
                  sensitivity: 1388.4,
                  selfNoise: 3.9,
                  operator: '林之遥',
                  agency: '国家测震台网计量中心',
                  remark: '自噪接近上限，判定不合格',
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  /* ------------------ 计量站标准器（含溯源证书；含“已过期”样本以演示折算口径） ------------------ */

  const standards: CalibrationStandard[] = [
    {
      id: 'std_prov_bb',
      name: '便携式地震计校准装置',
      model: 'GSB-2100',
      serialNo: 'GSB2100-省级-07',
      ownerAgency: '省地震局计量站',
      scopeTypes: ['宽频带', '短周期'],
      inUseFrom: '2020-01-01',
      inUseUntil: '',
      state: '在役',
      remark: '省级现场比对主用标准器',
      certificates: [
        {
          certNo: 'JL-2021-0318',
          issuedBy: '国家地震计量站',
          confirmDate: '2021-03-18',
          validFrom: '2021-03-18',
          validUntil: '2023-03-17',
          correctionFactor: 1.0,
          uncertaintyPct: 0.8,
          remark: '首轮溯源',
        },
        {
          // 刻意留出 2023-03-18 ~ 2024-03-19 的“空窗期”，落在该窗口的标定走「已折算」
          certNo: 'JL-2024-0320',
          issuedBy: '国家地震计量站',
          confirmDate: '2024-03-20',
          validFrom: '2024-03-20',
          validUntil: '2026-03-19',
          correctionFactor: 1.012,
          uncertaintyPct: 0.7,
          remark: '给出灵敏度修正因子 1.012',
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'std_natl_bb',
      name: '宽频带地震计校准标准装置',
      model: 'GSB-N3000',
      serialNo: 'GSBN3000-国家-02',
      ownerAgency: '国家测震台网计量中心',
      scopeTypes: ['宽频带', '强震'],
      inUseFrom: '2018-06-01',
      inUseUntil: '',
      state: '在役',
      remark: '国家台网中心比对面值标准',
      certificates: [
        {
          certNo: 'GS-2022-1107',
          issuedBy: '中国计量科学研究院',
          confirmDate: '2022-11-07',
          validFrom: '2022-11-07',
          validUntil: '2024-06-30',
          correctionFactor: 1.0,
          uncertaintyPct: 0.5,
          remark: '',
        },
        {
          // 最近证书有效期已过且无更新：演示“标准器一过期，比过的结论按新口径重算”
          certNo: 'GS-2024-0702',
          issuedBy: '中国计量科学研究院',
          confirmDate: '2024-07-02',
          validFrom: '2024-07-02',
          validUntil: '2025-07-01',
          correctionFactor: 0.995,
          uncertaintyPct: 0.5,
          remark: '最新校准已过期，待送检；历史结论按 0.995 折算留档',
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'std_old_st',
      name: '短周期地震计校准器（已停用）',
      model: 'GSB-900',
      serialNo: 'GSB900-省级-01',
      ownerAgency: '省地震局计量站',
      scopeTypes: ['短周期'],
      inUseFrom: '2015-01-01',
      inUseUntil: '2022-12-31',
      state: '停用',
      remark: '2022 年底退役；保留台账仅供历史结论追溯',
      certificates: [
        {
          certNo: 'JL-2020-0512',
          issuedBy: '国家地震计量站',
          confirmDate: '2020-05-12',
          validFrom: '2020-05-12',
          validUntil: '2022-05-11',
          correctionFactor: 1.0,
          uncertaintyPct: 1.2,
          remark: '退役前最后一次溯源',
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
  ];

  /** 按标定机构选“当时那台”标准器 */
  const standardByAgency = (agency: string): CalibrationStandard =>
    agency.includes('国家') ? standards[1] : standards[0];

  const replaces: Replace[] = [
    {
      id: 'rpl_ltx02_st',
      instrumentId: 'ins_ltx02_st',
      reason: '雷击导致仪器损坏，标定不合格',
      newSerialNo: 'L4C-20250301-21',
      date: today,
      state: '待更换',
      operator: '周渝',
      remark: '新仪器已到货，待停电窗口安装',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rpl_hx02_bb',
      instrumentId: 'ins_hx02_bb',
      reason: '自噪持续超标，按台网要求整机更换',
      newSerialNo: 'CMG-3E-20250410-33',
      date: daysAgo(20),
      state: '已更换',
      operator: '林之遥',
      remark: '已完成安装，待复核标定',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 18 * 86400000,
    },
    {
      id: 'rpl_ltx01_st',
      instrumentId: 'ins_ltx01_st',
      reason: '超期未标定，更换为新型号',
      newSerialNo: 'FSS3B-20250506-24',
      date: daysAgo(60),
      state: '已复核',
      operator: '陈立群',
      remark: '复核标定合格，序列号已回写',
      createdAt: now - 60 * 86400000,
      updatedAt: now - 30 * 86400000,
    },
  ];

  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces, db.standards],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset,
      });

      const arrayRows: SeisArray[] = [];
      const stationRows: SeisStation[] = [];
      const instrumentRows: Instrument[] = [];
      const calibrationRows: Calibration[] = [];

      arrays.forEach((seed, arrayIndex) => {
        const { stations, ...arrayRest } = seed;
        arrayRows.push({ ...arrayRest, stationCount: stations.length, ...stamp(arrayIndex) });
        stations.forEach((stationSeed, stationIndex) => {
          const { instruments, ...stationRest } = stationSeed;
          stationRows.push({ ...stationRest, ...stamp(100 + arrayIndex * 100 + stationIndex) });
          instruments.forEach((instrumentSeed, instrumentIndex) => {
            const { calibrations, ...instrumentRest } = instrumentSeed;
            instrumentRows.push({
              ...instrumentRest,
              ...stamp(200 + arrayIndex * 200 + stationIndex * 50 + instrumentIndex),
            });
            calibrations.forEach((calibrationSeed, calibrationIndex) => {
              const verdict = judgeCalibration(
                instrumentRest.type,
                calibrationSeed.sensitivity,
                calibrationSeed.selfNoise
              );

              // 旧数据没记标准器号的样本（2022 年短周期备份仪器首标）：演示“补不出先单列”
              const isLegacyUnlinked = calibrationSeed.id === 'cal_ltx01_st_1';
              const standard = isLegacyUnlinked ? null : standardByAgency(calibrationSeed.agency);
              const effect = recomputeCalibrationEffect(
                {
                  id: calibrationSeed.id,
                  instrumentId: calibrationSeed.instrumentId,
                  date: calibrationSeed.date,
                  sensitivity: calibrationSeed.sensitivity,
                  selfNoise: calibrationSeed.selfNoise,
                  responseVerdict: verdict,
                  operator: calibrationSeed.operator,
                  agency: calibrationSeed.agency,
                  remark: calibrationSeed.remark,
                  standardId: standard?.id ?? '',
                  standardSerialNo: standard?.serialNo ?? '',
                  traceCertNo: '',
                  effectiveSensitivity: null,
                  effectiveSelfNoise: null,
                  effectiveVerdict: '待判定',
                  effectStatus: '待重算',
                  effectBasis: null,
                  recompute: null,
                  ...stamp(0),
                },
                standard,
                instrumentRest.type,
                now
              );

              calibrationRows.push({
                ...calibrationSeed,
                responseVerdict: verdict,
                standardId: standard?.id ?? '',
                standardSerialNo: standard?.serialNo ?? '',
                traceCertNo: effect.basis?.certNo ?? '',
                effectiveSensitivity: effect.effectiveSensitivity,
                effectiveSelfNoise: effect.effectiveSelfNoise,
                effectiveVerdict: effect.effectiveVerdict,
                effectStatus: effect.status,
                effectBasis: effect.basis,
                recompute: isLegacyUnlinked
                  ? {
                      status: '待重算',
                      recomputedAt: now,
                      lastError: '旧数据未记标准器号，升级时按标定日期补不到当时在用的标准器，先单列待补挂',
                      attempts: 0,
                    }
                  : effect.recompute,
                ...stamp(
                  400 + arrayIndex * 400 + stationIndex * 100 + instrumentIndex * 20 + calibrationIndex
                ),
              });
            });
          });
        });
      });

      await db.standards.bulkPut(standards);
      await db.arrays.bulkPut(arrayRows);
      await db.stations.bulkPut(stationRows);
      await db.instruments.bulkPut(instrumentRows);
      await db.calibrations.bulkPut(calibrationRows);
      await db.replaces.bulkPut(replaces);
    }
  );
}

/** 打开数据库并幂等播种：仅当台阵表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.arrays.count();
  if (count === 0) {
    await seedDemoData();
  }
  stampDbVersion();
  // 注：v2→v3 升级后旧标定生效值的“按份补算”由 App 启动流程调用 recomputeAll() 完成，
  // 放在 db 模块之外以避免 db ↔ recompute 的循环依赖；标准器台账在重算中只读、不被改动。
}

/** 清空全部业务表（导入覆盖与重置共用；不清空会被导入文件整体覆盖，这里一并清空） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces, db.standards],
    async () => {
      await Promise.all([
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.calibrations.clear(),
        db.replaces.clear(),
        db.standards.clear(),
      ]);
    }
  );
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDemoData();
}

/** 统计各表行数，供页脚概览与几何页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [arrays, stations, instruments, calibrations, replaces, standards] = await Promise.all([
    db.arrays.count(),
    db.stations.count(),
    db.instruments.count(),
    db.calibrations.count(),
    db.replaces.count(),
    db.standards.count(),
  ]);
  return { arrays, stations, instruments, calibrations, replaces, standards };
}

/** 写入结构版本号到 localStorage，便于几何页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION));
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso);
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function readLastArrayId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastArrayId);
  } catch {
    return null;
  }
}

export function writeLastArrayId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastArrayId);
    else localStorage.setItem(LS_KEYS.lastArrayId, id);
  } catch {
    // 忽略
  }
}
