/**
 * 标准器 slice（计量站侧）：维护标准器台账与溯源证书、校准有效期。
 * 台网中心页面只读此 slice；续证 / 改修正因子后触发挂接结论重算（只动 calibrations）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { CalibrationStandard, StandardDraft, TraceCertificate } from '@/types/standard';
import { recomputeByStandard } from '@/utils/recompute';
import type { RootState } from '@/stores/store';

type WithStandard = RootState;

export interface StandardSliceState {
  standards: CalibrationStandard[];
  ready: boolean;
  error: string | null;
  lastReceipt: string;
}

const initialState: StandardSliceState = {
  standards: [],
  ready: false,
  error: null,
  lastReceipt: '',
};

function sortCerts(certificates: TraceCertificate[]): TraceCertificate[] {
  return [...certificates].sort((a, b) => a.confirmDate.localeCompare(b.confirmDate));
}

export const createStandard = createAsyncThunk(
  'standard/createStandard',
  async (payload: StandardDraft & { certificates?: TraceCertificate[] }) => {
    const now = Date.now();
    const row: CalibrationStandard = {
      ...payload,
      certificates: sortCerts(payload.certificates ?? []),
      id: createId('std'),
      createdAt: now,
      updatedAt: now,
    };
    await db.standards.put(row);
    return row;
  }
);

export const updateStandard = createAsyncThunk(
  'standard/updateStandard',
  async (payload: { id: string; patch: Partial<StandardDraft> }) => {
    await db.standards.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

export const removeStandard = createAsyncThunk('standard/removeStandard', async (id: string) => {
  await db.standards.delete(id);
  return id;
});

/** 追加一张溯源证书（续证），随后让挂接该标准器的全部结论重算一版 */
export const addCertificate = createAsyncThunk(
  'standard/addCertificate',
  async (payload: { standardId: string; certificate: TraceCertificate }) => {
    const standard = await db.standards.get(payload.standardId);
    if (!standard) throw new Error('标准器不存在');
    if (standard.certificates.some((cert) => cert.certNo === payload.certificate.certNo)) {
      throw new Error('该证书号已存在，请勿重复登记');
    }
    const certificates = sortCerts([...standard.certificates, payload.certificate]);
    await db.standards.update(payload.standardId, { certificates, updatedAt: Date.now() } as never);
    const affected = await recomputeByStandard(payload.standardId);
    return { standardId: payload.standardId, affected };
  }
);

/** 删除一张溯源证书，随后重算挂接结论 */
export const removeCertificate = createAsyncThunk(
  'standard/removeCertificate',
  async (payload: { standardId: string; certNo: string }) => {
    const standard = await db.standards.get(payload.standardId);
    if (!standard) throw new Error('标准器不存在');
    const certificates = standard.certificates.filter((cert) => cert.certNo !== payload.certNo);
    await db.standards.update(payload.standardId, { certificates, updatedAt: Date.now() } as never);
    const affected = await recomputeByStandard(payload.standardId);
    return { ...payload, affected };
  }
);

/** 停用 / 重新启用标准器（停用后不承接新标定，历史挂接仍重算） */
export const setStandardState = createAsyncThunk(
  'standard/setStandardState',
  async (payload: { id: string; state: CalibrationStandard['state']; inUseUntil?: string }) => {
    await db.standards.update(payload.id, {
      state: payload.state,
      inUseUntil: payload.inUseUntil ?? (payload.state === '停用' ? new Date().toISOString().slice(0, 10) : ''),
      updatedAt: Date.now(),
    } as never);
    const affected = await recomputeByStandard(payload.id);
    return { ...payload, affected };
  }
);

const standardSlice = createSlice({
  name: 'standard',
  initialState,
  reducers: {
    setStandards(state, action: PayloadAction<CalibrationStandard[]>) {
      state.standards = action.payload;
      state.ready = true;
      state.error = null;
    },
    setStandardError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setStandardReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(addCertificate.fulfilled, (state, action) => {
        state.lastReceipt = `溯源证书已登记，挂接该标准器的 ${action.payload.affected} 份结论已按新口径重算`;
      })
      .addCase(addCertificate.rejected, (state, action) => {
        state.error = action.error.message ?? '溯源证书登记失败';
      })
      .addCase(removeCertificate.fulfilled, (state, action) => {
        state.lastReceipt = `证书已删除，${action.payload.affected} 份结论已重算`;
      })
      .addCase(setStandardState.fulfilled, (state, action) => {
        state.lastReceipt = `标准器已${action.payload.state === '停用' ? '停用' : '启用'}，${action.payload.affected} 份结论已重算`;
      });
  },
});

export const { setStandards, setStandardError, setStandardReceipt } = standardSlice.actions;

let started = false;

/** 启动标准器表实时订阅（幂等） */
export function startStandardSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<CalibrationStandard>(() => db.standards).subscribe((rows) => {
    dispatch(setStandards(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectStandards = (state: WithStandard): CalibrationStandard[] =>
  state.standard.standards;
export const selectStandardReady = (state: WithStandard): boolean => state.standard.ready;
export const selectStandardById = (
  state: WithStandard,
  id: string | null | undefined
): CalibrationStandard | null =>
  id ? state.standard.standards.find((row) => row.id === id) ?? null : null;

export default standardSlice.reducer;
