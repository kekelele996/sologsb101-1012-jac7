/**
 * 标定 slice：维护标定记录、筛选条件与灵敏度派生值；
 * 同时维护更换记录（合格评定与更换提醒同属标定成果的下游动作）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type {
  Calibration,
  CalibrationFilterState,
  ResponseVerdict,
} from '@/types/calibration';
import { createEmptyCalibrationFilter, judgeCalibration, sensitivityDelta } from '@/types/calibration';
import { recomputeCalibrationEffect } from '@/utils/traceability';
import { recomputeOne, attachStandardAndRecompute } from '@/utils/recompute';
import type { Replace, ReplaceFilterState, ReplaceState } from '@/types/replace';
import { canTransition, createEmptyReplaceFilter } from '@/types/replace';
import type { Instrument } from '@/types/instrument';
import type { CalibrationStandard } from '@/types/standard';
import type { RootState } from '@/stores/store';

/** 新建/编辑标定表单提交字段（含挂接的计量标准器） */
export type CalibrationInput = Omit<
  Calibration,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'responseVerdict'
  | 'standardSerialNo'
  | 'traceCertNo'
  | 'effectiveSensitivity'
  | 'effectiveSelfNoise'
  | 'effectiveVerdict'
  | 'effectStatus'
  | 'effectBasis'
  | 'recompute'
> & { responseVerdict?: ResponseVerdict };

/** 按标准器折算生效值并补齐挂接冗余字段 */
function withEffect(
  row: Calibration,
  instrument: Instrument | undefined,
  standard: CalibrationStandard | undefined
): Calibration {
  const effect = recomputeCalibrationEffect(row, standard ?? null, instrument?.type ?? '宽频带', Date.now());
  return {
    ...row,
    effectiveSensitivity: effect.effectiveSensitivity,
    effectiveSelfNoise: effect.effectiveSelfNoise,
    effectiveVerdict: effect.effectiveVerdict,
    effectStatus: effect.status,
    effectBasis: effect.basis,
    recompute: effect.recompute,
    standardSerialNo: effect.basis?.standardSerialNo ?? standard?.serialNo ?? '',
    traceCertNo: effect.basis?.certNo ?? '',
  };
}

/** 选择器入参统一用 RootState */
type WithCalibration = RootState;

export interface CalibrationSliceState {
  calibrations: Calibration[];
  replaces: Replace[];
  instruments: Instrument[];
  ready: boolean;
  error: string | null;
  filter: CalibrationFilterState;
  replaceFilter: ReplaceFilterState;
  /** 最近一次操作回执 */
  lastReceipt: string;
}

const initialState: CalibrationSliceState = {
  calibrations: [],
  replaces: [],
  instruments: [],
  ready: false,
  error: null,
  filter: createEmptyCalibrationFilter(),
  replaceFilter: createEmptyReplaceFilter(),
  lastReceipt: '',
};

export const createCalibration = createAsyncThunk(
  'calibration/createCalibration',
  async (payload: CalibrationInput) => {
    const now = Date.now();
    const instrument = await db.instruments.get(payload.instrumentId);
    const verdict = judgeCalibration(
      instrument?.type ?? '宽频带',
      payload.sensitivity,
      payload.selfNoise
    );
    const standard = payload.standardId ? await db.standards.get(payload.standardId) : undefined;
    const base: Calibration = {
      ...payload,
      responseVerdict: payload.responseVerdict ?? verdict,
      id: createId('cal'),
      standardSerialNo: '',
      traceCertNo: '',
      effectiveSensitivity: null,
      effectiveSelfNoise: null,
      effectiveVerdict: '待判定',
      effectStatus: '待重算',
      effectBasis: null,
      recompute: null,
      createdAt: now,
      updatedAt: now,
    };
    const row = withEffect(base, instrument, standard);
    await db.calibrations.put(row);
    // 标定完成后按“生效结论”回写仪器状态（待重算 / 重算失败不视作合格）
    if (instrument) {
      const effectiveOk = row.effectStatus === '原值有效' || row.effectStatus === '已折算';
      const state =
        !effectiveOk || row.effectiveVerdict === '不合格' ? '待标定' : '在用';
      await db.instruments.update(instrument.id, { state, updatedAt: now } as never);
    }
    return row;
  }
);

export const updateCalibration = createAsyncThunk(
  'calibration/updateCalibration',
  async (payload: { id: string; patch: Partial<CalibrationInput> }) => {
    const existing = await db.calibrations.get(payload.id);
    if (!existing) return payload;
    const instrument = await db.instruments.get(existing.instrumentId);
    const nextSensitivity = payload.patch.sensitivity ?? existing.sensitivity;
    const nextNoise = payload.patch.selfNoise ?? existing.selfNoise;
    const autoVerdict = judgeCalibration(instrument?.type ?? '宽频带', nextSensitivity, nextNoise);

    const standardId = payload.patch.standardId ?? existing.standardId;
    const standard = standardId ? await db.standards.get(standardId) : undefined;

    const merged: Calibration = {
      ...existing,
      ...payload.patch,
      responseVerdict: payload.patch.responseVerdict ?? existing.responseVerdict ?? autoVerdict,
      standardId,
      updatedAt: Date.now(),
    };
    const row = withEffect(merged, instrument, standard);
    await db.calibrations.put(row);
    return payload;
  }
);

/**
 * 台网中心重出失败后“只重试这份”：重算单份生效值。
 * 只读标准器台账，无论成功失败都不改动 standards 表。
 */
export const retryCalibrationEffect = createAsyncThunk(
  'calibration/retryCalibrationEffect',
  async (calibrationId: string, { rejectWithValue }) => {
    try {
      const row = await recomputeOne(calibrationId);
      return { id: calibrationId, status: row.effectStatus, error: row.recompute?.lastError ?? '' };
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '重算失败');
    }
  }
);

/** 旧数据补挂标准器后，让这批“补不出先单列”的结论重算 */
export const attachStandards = createAsyncThunk(
  'calibration/attachStandards',
  async (payload: { calibrationIds: string[]; standardId: string }, { rejectWithValue }) => {
    try {
      const count = await attachStandardAndRecompute(payload.calibrationIds, payload.standardId);
      return { count };
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '补挂失败');
    }
  }
);

export const removeCalibration = createAsyncThunk(
  'calibration/removeCalibration',
  async (calibrationId: string) => {
    await db.calibrations.delete(calibrationId);
    return calibrationId;
  }
);

/** 批量改响应结论（标定记录台的批量操作） */
export const bulkSetVerdict = createAsyncThunk(
  'calibration/bulkSetVerdict',
  async (payload: { ids: string[]; verdict: ResponseVerdict }) => {
    const now = Date.now();
    // 原始结论留档可批量订正；生效口径中“已折算/原值有效”的份同步采用人工结论，
    // 待重算/重算失败的份仍单列，不因此变成合格。
    await db.calibrations
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.responseVerdict = payload.verdict;
        if (row.effectStatus === '原值有效' || row.effectStatus === '已折算') {
          row.effectiveVerdict = payload.verdict;
        }
        row.updatedAt = now;
      });
    return payload;
  }
);

/* ------------------------------ 更换记录 ------------------------------ */

export const createReplace = createAsyncThunk(
  'calibration/createReplace',
  async (payload: Omit<Replace, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = Date.now();
    const row: Replace = { ...payload, id: createId('rpl'), createdAt: now, updatedAt: now };
    await db.replaces.put(row);
    return row;
  }
);

export const updateReplace = createAsyncThunk(
  'calibration/updateReplace',
  async (payload: { id: string; patch: Partial<Replace> }) => {
    await db.replaces.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/**
 * 推进更换状态机：
 * 流转到「已更换」时回写仪器序列号并置为在用（更换完成后回写仪器序列号并归档旧记录）。
 */
export const transitionReplace = createAsyncThunk(
  'calibration/transitionReplace',
  async (
    payload: { id: string; next: ReplaceState },
    { rejectWithValue }
  ) => {
    const replace = await db.replaces.get(payload.id);
    if (!replace) return rejectWithValue('更换记录不存在');
    if (!canTransition(replace.state, payload.next)) {
      return rejectWithValue(`状态机不允许从「${replace.state}」流转到「${payload.next}」`);
    }
    const now = Date.now();
    await db.transaction('rw', [db.replaces, db.instruments], async () => {
      await db.replaces.update(payload.id, { state: payload.next, updatedAt: now } as never);
      if (payload.next === '已更换' && replace.newSerialNo) {
        await db.instruments.update(replace.instrumentId, {
          serialNo: replace.newSerialNo,
          state: '在用',
          updatedAt: now,
        } as never);
      }
    });
    return payload;
  }
);

export const removeReplace = createAsyncThunk('calibration/removeReplace', async (id: string) => {
  await db.replaces.delete(id);
  return id;
});

const calibrationSlice = createSlice({
  name: 'calibration',
  initialState,
  reducers: {
    setCalibrations(state, action: PayloadAction<Calibration[]>) {
      state.calibrations = action.payload;
      state.ready = true;
      state.error = null;
    },
    setReplaces(state, action: PayloadAction<Replace[]>) {
      state.replaces = action.payload;
    },
    setInstrumentsForCalibration(state, action: PayloadAction<Instrument[]>) {
      state.instruments = action.payload;
    },
    patchFilter(state, action: PayloadAction<Partial<CalibrationFilterState>>) {
      state.filter = { ...state.filter, ...action.payload };
    },
    resetFilter(state) {
      state.filter = createEmptyCalibrationFilter();
    },
    patchReplaceFilter(state, action: PayloadAction<Partial<ReplaceFilterState>>) {
      state.replaceFilter = { ...state.replaceFilter, ...action.payload };
    },
    resetReplaceFilter(state) {
      state.replaceFilter = createEmptyReplaceFilter();
    },
    setCalibrationError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setCalibrationReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createCalibration.fulfilled, (state, action) => {
        state.lastReceipt = `标定记录已保存，响应结论自动初判为「${action.payload.responseVerdict}」`;
      })
      .addCase(bulkSetVerdict.fulfilled, (state, action) => {
        state.lastReceipt = `已批量将 ${action.payload.ids.length} 条标定记录的响应结论改为「${action.payload.verdict}」`;
      })
      .addCase(transitionReplace.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.next === '已更换'
            ? '更换完成：已回写仪器序列号并置为在用，旧记录已归档'
            : `更换记录状态已流转到「${action.payload.next}」`;
      })
      .addCase(transitionReplace.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '更换状态流转失败';
      })
      .addCase(retryCalibrationEffect.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.status === '重算失败' || action.payload.status === '待重算'
            ? `这份结论仍为「${action.payload.status}」：${action.payload.error}（标准器台账未改动，可继续重试这一份）`
            : `这份结论已重算为「${action.payload.status}」，合格率与更换提醒已按生效口径刷新`;
      })
      .addCase(attachStandards.fulfilled, (state, action) => {
        state.lastReceipt = `已为 ${action.payload.count} 份旧结论补挂标准器并重算生效值`;
      });
  },
});

export const {
  setCalibrations,
  setReplaces,
  setInstrumentsForCalibration,
  patchFilter,
  resetFilter,
  patchReplaceFilter,
  resetReplaceFilter,
  setCalibrationError,
  setCalibrationReceipt,
} = calibrationSlice.actions;

let started = false;

/** 启动标定 / 更换 / 仪器表实时订阅（幂等） */
export function startCalibrationSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Calibration>(() => db.calibrations).subscribe((rows) => {
    dispatch(setCalibrations(rows));
  });
  watchTable<Replace>(() => db.replaces).subscribe((rows) => {
    dispatch(setReplaces(rows));
  });
  watchTable<Instrument>(() => db.instruments).subscribe((rows) => {
    dispatch(setInstrumentsForCalibration(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectCalibrationState = (state: WithCalibration): CalibrationSliceState =>
  state.calibration;
export const selectCalibrations = (state: WithCalibration): Calibration[] =>
  state.calibration.calibrations;
export const selectReplaces = (state: WithCalibration): Replace[] => state.calibration.replaces;
export const selectCalibrationReady = (state: WithCalibration): boolean => state.calibration.ready;
export const selectCalibrationFilter = (state: WithCalibration): CalibrationFilterState =>
  state.calibration.filter;
export const selectReplaceFilter = (state: WithCalibration): ReplaceFilterState =>
  state.calibration.replaceFilter;
export const selectCalibrationReceipt = (state: WithCalibration): string =>
  state.calibration.lastReceipt;

export const selectCalibrationsOfInstrument = (
  state: WithCalibration,
  instrumentId: string | null | undefined
): Calibration[] => {
  if (!instrumentId) return [];
  return state.calibration.calibrations
    .filter((row) => row.instrumentId === instrumentId)
    .sort((a, b) => b.date.localeCompare(a.date));
};

export const selectReplacesOfInstrument = (
  state: WithCalibration,
  instrumentId: string | null | undefined
): Replace[] => {
  if (!instrumentId) return [];
  return state.calibration.replaces.filter((row) => row.instrumentId === instrumentId);
};

/** 标定 id → 灵敏度变化（相对同仪器上一次标定） */
export const selectSensitivityDeltas = (
  state: WithCalibration
): Record<string, ReturnType<typeof sensitivityDelta>> => {
  const result: Record<string, ReturnType<typeof sensitivityDelta>> = {};
  const grouped = new Map<string, Calibration[]>();
  state.calibration.calibrations.forEach((row) => {
    const list = grouped.get(row.instrumentId) ?? [];
    list.push(row);
    grouped.set(row.instrumentId, list);
  });
  grouped.forEach((list) => {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    sorted.forEach((row, index) => {
      const previous = index > 0 ? sorted[index - 1].sensitivity : null;
      result[row.id] = sensitivityDelta(row.sensitivity, previous);
    });
  });
  return result;
};

/** 需要台网中心处理（待重算 / 重算失败）的标定：单列、不进合格率与更换口径 */
export const selectCalibrationsNeedingAttention = (state: WithCalibration): Calibration[] =>
  state.calibration.calibrations.filter(
    (row) => row.effectStatus === '待重算' || row.effectStatus === '重算失败'
  );

export default calibrationSlice.reducer;