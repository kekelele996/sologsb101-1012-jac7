/**
 * 标准器 slice（计量站管辖）：标准器台账的增删改查与实时订阅。
 * 台网中心的标定记录通过 standardId 挂接标准器，生效结论另算。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { Standard, StandardDraft } from '@/types/standard';
import type { RootState } from '@/stores/store';

export interface StandardSliceState {
  standards: Standard[];
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

export const createStandard = createAsyncThunk(
  'standard/createStandard',
  async (payload: StandardDraft) => {
    const now = Date.now();
    const row: Standard = {
      ...payload,
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

const standardSlice = createSlice({
  name: 'standard',
  initialState,
  reducers: {
    setStandards(state, action: PayloadAction<Standard[]>) {
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
      .addCase(createStandard.fulfilled, (state) => {
        state.lastReceipt = '标准器台账已新增';
      })
      .addCase(updateStandard.fulfilled, (state) => {
        state.lastReceipt = '标准器台账已更新';
      })
      .addCase(removeStandard.fulfilled, (state) => {
        state.lastReceipt = '标准器台账已删除';
      });
  },
});

export const { setStandards, setStandardError, setStandardReceipt } = standardSlice.actions;

let started = false;

/** 启动标准器表实时订阅（幂等） */
export function startStandardSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Standard>(() => db.standards).subscribe((rows) => {
    dispatch(setStandards(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectStandards = (state: RootState): Standard[] => state.standard.standards;
export const selectStandardReady = (state: RootState): boolean => state.standard.ready;

export const selectStandardById = (
  state: RootState,
  id: string | null | undefined
): Standard | null => {
  if (!id) return null;
  return state.standard.standards.find((row) => row.id === id) ?? null;
};

export default standardSlice.reducer;
