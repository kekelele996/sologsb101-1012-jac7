/**
 * 模块 3：/calibrations 标定记录台
 * 录入灵敏度 / 自噪 / 脉冲响应结论并批量改结论，叠加多次标定并绘出灵敏度趋势。
 * 复用 <FilterBar>、<QualifyTag>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  RetweetOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import {
  attachStandards,
  bulkSetVerdict,
  createCalibration,
  patchFilter,
  removeCalibration,
  resetFilter,
  retryCalibrationEffect,
  selectCalibrationFilter,
  selectCalibrations,
  updateCalibration,
} from '@/stores/calibrationSlice';
import { selectStandards } from '@/stores/standardSlice';
import {
  EFFECT_STATUSES,
  EFFECT_STATUS_COLOR,
  RESPONSE_VERDICTS,
  SELF_NOISE_LIMIT,
  SENSITIVITY_RANGE,
  isEffectUsable,
  sensitivityDelta,
  type Calibration,
  type EffectStatus,
  type ResponseVerdict,
} from '@/types/calibration';
import { INSTRUMENT_TYPES, type InstrumentType } from '@/types/instrument';
import { round } from '@/utils/geo';
import { initDatabase } from '@/utils/db';
import { effectQualifyStats } from '@/utils/export';
import { caliberStatusAt, type CalibrationStandard } from '@/types/standard';
import { recomputeAll } from '@/utils/recompute';

interface CalibrationFormValues {
  instrumentId: string;
  standardId: string;
  date: dayjs.Dayjs | null;
  sensitivity: number;
  selfNoise: number;
  responseVerdict: ResponseVerdict;
  operator: string;
  agency: string;
  remark: string;
}

/** 标定行：附带仪器、台站、台阵、标准器与生效值信息 */
interface CalibrationRow {
  row: Calibration;
  instrumentModel: string;
  instrumentType: string;
  serialNo: string;
  stationCode: string;
  arrayName: string;
  arrayId: string;
  standardName: string;
  delta: ReturnType<typeof sensitivityDelta>;
}

export default function CalibrationBoard() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  const calibrations = useAppSelector(selectCalibrations);
  const instruments = useAppSelector(selectInstruments);
  const stations = useAppSelector(selectStations);
  const arrays = useAppSelector(selectArrays);
  const standards = useAppSelector(selectStandards);
  const filter = useAppSelector(selectCalibrationFilter);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [trendInstrumentId, setTrendInstrumentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachStandardId, setAttachStandardId] = useState<string | undefined>(undefined);
  const [basisOf, setBasisOf] = useState<Calibration | null>(null);
  const [form] = Form.useForm<CalibrationFormValues>();

  useEffect(() => {
    dispatch(
      patchFilter({
        keyword: searchParams.get('kw') ?? '',
        verdicts: (searchParams.get('verdict')?.split(',').filter(Boolean) ?? []) as ResponseVerdict[],
        instrumentTypes: searchParams.get('type')?.split(',').filter(Boolean) ?? [],
        effectStatuses: (searchParams.get('effect')?.split(',').filter(Boolean) ?? []) as EffectStatus[],
        onlyOverdue: searchParams.get('overdue') === '1',
      })
    );
    if (arrays.length === 0) void initDatabase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 标准器 id → 台账信息（计量站侧只读） */
  const standardIndex = useMemo(() => {
    const map = new Map<string, Pick<CalibrationStandard, 'name' | 'serialNo'>>();
    standards.forEach((standard) =>
      map.set(standard.id, { name: standard.name, serialNo: standard.serialNo })
    );
    return map;
  }, [standards]);

  const instrumentIndex = useMemo(() => {
    const map = new Map<
      string,
      { model: string; type: string; serialNo: string; stationCode: string; arrayName: string; arrayId: string }
    >();
    instruments.forEach((instrument) => {
      const station = stations.find((row) => row.id === instrument.stationId);
      const array = station ? arrays.find((row) => row.id === station.arrayId) : undefined;
      map.set(instrument.id, {
        model: instrument.model,
        type: instrument.type,
        serialNo: instrument.serialNo,
        stationCode: station?.code ?? '未知台站',
        arrayName: array?.name ?? '未知台阵',
        arrayId: array?.id ?? '',
      });
    });
    return map;
  }, [arrays, instruments, stations]);

  /** 逐仪器排序后的标定序列，用于计算灵敏度变化（取生效灵敏度） */
  const deltaIndex = useMemo(() => {
    const grouped = new Map<string, Calibration[]>();
    calibrations.forEach((row) => {
      const list = grouped.get(row.instrumentId) ?? [];
      list.push(row);
      grouped.set(row.instrumentId, list);
    });
    const result = new Map<string, ReturnType<typeof sensitivityDelta>>();
    grouped.forEach((list) => {
      const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
      sorted.forEach((row, index) => {
        const current = row.effectiveSensitivity ?? row.sensitivity;
        const prev = index > 0 ? sorted[index - 1].effectiveSensitivity ?? sorted[index - 1].sensitivity : null;
        result.set(row.id, sensitivityDelta(current, prev));
      });
    });
    return result;
  }, [calibrations]);

  const rows = useMemo<CalibrationRow[]>(() => {
    return calibrations
      .map((row) => {
        const info = instrumentIndex.get(row.instrumentId);
        const standardInfo = row.standardId ? standardIndex.get(row.standardId) : undefined;
        return {
          row,
          instrumentModel: info?.model ?? '仪器已删除',
          instrumentType: info?.type ?? '未知',
          serialNo: info?.serialNo ?? '—',
          stationCode: info?.stationCode ?? '—',
          arrayName: info?.arrayName ?? '—',
          arrayId: info?.arrayId ?? '',
          standardName: standardInfo
            ? `${standardInfo.name}（${standardInfo.serialNo}）`
            : row.standardSerialNo
              ? `已删标准器（${row.standardSerialNo}）`
              : '未挂标准器',
          delta: deltaIndex.get(row.id) ?? sensitivityDelta(row.effectiveSensitivity ?? row.sensitivity, null),
        };
      })
      .filter((item) => {
        const keyword = filter.keyword.trim();
        if (keyword.length > 0) {
          const haystack = `${item.instrumentModel}${item.serialNo}${item.stationCode}${item.arrayName}${item.row.operator}${item.row.agency}${item.row.standardSerialNo}${item.row.traceCertNo}`;
          if (!haystack.includes(keyword)) return false;
        }
        // 生效结论维度过滤（同时兼容原“响应结论”筛选项）
        if (filter.verdicts.length > 0 && !filter.verdicts.includes(item.row.effectiveVerdict)) return false;
        if (filter.instrumentTypes.length > 0 && !filter.instrumentTypes.includes(item.instrumentType)) return false;
        if (filter.effectStatuses.length > 0 && !filter.effectStatuses.includes(item.row.effectStatus)) return false;
        if (filter.onlyOverdue && item.row.effectiveVerdict !== '不合格') return false;
        return true;
      })
      .sort((a, b) => b.row.date.localeCompare(a.row.date));
  }, [calibrations, deltaIndex, filter, instrumentIndex, standardIndex]);

  const totals = useMemo(() => {
    // 合格率统一生效口径：待重算 / 重算失败单列、不进分母
    const stats = effectQualifyStats(rows.map((item) => item.row));
    const usableRows = rows.filter((item) => isEffectUsable(item.row.effectStatus));
    const meanSensitivity =
      usableRows.length === 0
        ? 0
        : round(
            usableRows.reduce((sum, item) => sum + (item.row.effectiveSensitivity ?? 0), 0) / usableRows.length,
            1
          );
    const meanNoise =
      usableRows.length === 0
        ? 0
        : round(
            usableRows.reduce((sum, item) => sum + (item.row.effectiveSelfNoise ?? 0), 0) / usableRows.length,
            2
          );
    return {
      count: rows.length,
      unqualified: stats.unqualified,
      pending: stats.pending,
      qualifyRate: stats.rate,
      meanSensitivity,
      meanNoise,
      operatorCount: new Set(rows.map((item) => item.row.operator)).size,
    };
  }, [rows]);

  /** 待重算 / 重算失败：可批量补挂标准器或逐份重试 */
  const attentionRows = useMemo(
    () => calibrations.filter((row) => !isEffectUsable(row.effectStatus)),
    [calibrations]
  );

  const filterModel: FilterModel = {
    keyword: filter.keyword,
    verdicts: filter.verdicts,
    instrumentTypes: filter.instrumentTypes,
  };

  const trendRows = useMemo(() => {
    const targetId = trendInstrumentId ?? rows[0]?.row.instrumentId ?? null;
    if (!targetId) return { targetId: null as string | null, points: [] as Calibration[] };
    return {
      targetId,
      points: calibrations
        .filter((row) => row.instrumentId === targetId)
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }, [calibrations, rows, trendInstrumentId]);

  /** 给定仪器与标定日期，给出默认可挂的标准器（在役、适用、当日校准有效优先） */
  const suggestStandardId = (instrumentType: string, date: dayjs.Dayjs): string => {
    const dateStr = date.format('YYYY-MM-DD');
    const usable = standards
      .filter((standard) => standard.state === '在役' && standard.scopeTypes.includes(instrumentType))
      .sort((a, b) => b.inUseFrom.localeCompare(a.inUseFrom));
    const valid = usable.find((standard) => caliberStatusAt(standard, dateStr) === '有效');
    return (valid ?? usable[0])?.id ?? '';
  };

  const openCreate = () => {
    setEditingId(null);
    const firstInstrument = instruments[0];
    const type = (firstInstrument?.type ?? '宽频带') as InstrumentType;
    const range = SENSITIVITY_RANGE[type];
    const date = dayjs();
    form.setFieldsValue({
      instrumentId: firstInstrument?.id ?? '',
      standardId: suggestStandardId(type, date),
      date,
      sensitivity: round((range.min + range.max) / 2, 2),
      selfNoise: 1.5,
      responseVerdict: '合格',
      operator: '陈立群',
      agency: '省地震局计量站',
      remark: '',
    });
    setModalOpen(true);
  };

  const openEdit = (row: Calibration) => {
    setEditingId(row.id);
    form.setFieldsValue({
      instrumentId: row.instrumentId,
      standardId: row.standardId,
      date: dayjs(row.date),
      sensitivity: row.sensitivity,
      selfNoise: row.selfNoise,
      responseVerdict: row.responseVerdict,
      operator: row.operator,
      agency: row.agency,
      remark: row.remark,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        instrumentId: values.instrumentId,
        standardId: values.standardId ?? '',
        date: values.date ? values.date.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        sensitivity: Number(values.sensitivity),
        selfNoise: Number(values.selfNoise),
        operator: values.operator.trim(),
        agency: values.agency?.trim() ?? '',
        remark: values.remark?.trim() ?? '',
      };
      if (editingId) {
        await dispatch(updateCalibration({ id: editingId, patch: payload })).unwrap();
        message.success('标定记录已更新，生效结论已按所挂标准器重新折算');
      } else {
        const result = await dispatch(createCalibration(payload)).unwrap();
        message.success(
          result.effectStatus === '原值有效'
            ? '标定记录已保存，标准器在有效期内，原值即生效值'
            : result.effectStatus === '已折算'
              ? `标定记录已保存：标准器已过期，原值留档，已折算生效值（${result.effectiveVerdict}）`
              : '标定记录已保存，但挂不到有效标准器，结论已列为“待重算”，不计入合格率'
        );
      }
      setModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  /** 台网中心重出失败后只重试这一份（标准器台账不动） */
  const retryOne = async (id: string) => {
    const action = await dispatch(retryCalibrationEffect(id)).unwrap();
    if (action.status === '重算失败' || action.status === '待重算') {
      message.warning(`这份仍为「${action.status}」：${action.error}`);
    } else {
      message.success(`这份结论已重算为「${action.status}」`);
    }
  };

  /** 全量按当前标准器/证书重算（续证后的手动兜底） */
  const recomputeAllNow = async () => {
    const report = await recomputeAll({ force: true });
    message.success(
      `已重算 ${report.recomputed} 份：生效可用 ${report.usable}，待重算 ${report.pending}，失败 ${report.failed}（标准器台账未改动）`
    );
  };

  /** 为勾选/全部待重算的旧结论补挂标准器 */
  const submitAttach = async () => {
    if (!attachStandardId) {
      message.warning('请先选择要补挂的标准器');
      return;
    }
    const ids = selectedKeys.length > 0 ? selectedKeys : attentionRows.map((row) => row.id);
    const result = await dispatch(attachStandards({ calibrationIds: ids, standardId: attachStandardId })).unwrap();
    message.success(`已为 ${result.count} 份旧结论补挂标准器并重算`);
    setSelectedKeys([]);
    setAttachOpen(false);
    setAttachStandardId(undefined);
  };

  const handleBulkVerdict = async (verdict: ResponseVerdict) => {
    if (selectedKeys.length === 0) {
      message.warning('请先勾选要批量改结论的记录');
      return;
    }
    await dispatch(bulkSetVerdict({ ids: selectedKeys, verdict })).unwrap();
    message.success(`已将 ${selectedKeys.length} 条标定记录的响应结论改为「${verdict}」`);
    setSelectedKeys([]);
  };

  const handleFilterChange = (next: FilterModel, switchValue: boolean) => {
    dispatch(
      patchFilter({
        keyword: next.keyword,
        verdicts: ((next.verdicts as string[]) ?? []) as ResponseVerdict[],
        instrumentTypes: (next.instrumentTypes as string[]) ?? [],
        onlyOverdue: switchValue,
      })
    );
    const params = new URLSearchParams();
    if (next.keyword.trim()) params.set('kw', next.keyword.trim());
    if (((next.verdicts as string[]) ?? []).length > 0) params.set('verdict', ((next.verdicts as string[]) ?? []).join(','));
    if (((next.instrumentTypes as string[]) ?? []).length > 0)
      params.set('type', ((next.instrumentTypes as string[]) ?? []).join(','));
    if (filter.effectStatuses.length > 0) params.set('effect', filter.effectStatuses.join(','));
    if (switchValue) params.set('overdue', '1');
    setSearchParams(params, { replace: true });
  };

  const handleReset = () => {
    dispatch(resetFilter());
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  /** 灵敏度趋势图坐标 */
  const trendChart = useMemo(() => {
    // 只对“生效口径可用”的记录连线，待重算 / 重算失败的份不参与
    const points = trendRows.points.filter((row) => isEffectUsable(row.effectStatus));
    if (points.length === 0) {
      return { line: '', dots: [] as Array<{ id: string; cx: number; cy: number; date: string; sensitivity: number }>, min: 0, max: 0 };
    }
    const sensitivities = points.map((row) => row.effectiveSensitivity ?? row.sensitivity);
    const min = Math.min(...sensitivities) * 0.98;
    const max = Math.max(...sensitivities) * 1.02;
    const left = 58;
    const right = 340;
    const top = 20;
    const bottom = 190;
    const toX = (index: number): number =>
      points.length === 1 ? (left + right) / 2 : left + (index * (right - left)) / (points.length - 1);
    const toY = (value: number): number =>
      max - min < 1e-6 ? (top + bottom) / 2 : bottom - ((value - min) / (max - min)) * (bottom - top);
    const dots = points.map((row, index) => ({
      id: row.id,
      cx: Number(toX(index).toFixed(1)),
      cy: Number(toY(row.effectiveSensitivity ?? row.sensitivity).toFixed(1)),
      date: row.date,
      sensitivity: row.effectiveSensitivity ?? row.sensitivity,
    }));
    return { line: dots.map((dot) => `${dot.cx},${dot.cy}`).join(' '), dots, min, max };
  }, [trendRows]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            标定记录台
          </Typography.Title>
          <p className="gb-hint">
            每份结论都挂比对当时所用的计量标准器。标准器在校准有效期内时原值即生效值；标准器过期后
            <b> 保留原值、另算生效值并标出依据</b>。本页合格率、平均量值与下游更换提醒/导出一律按
            <b> 生效口径</b>；待重算 / 重算失败的结论单列、不计入合格率。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void recomputeAllNow()}>
            全量重算生效值
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void initDatabase()}>
            补齐演示数据
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增标定记录
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="标定记录" value={totals.count} suffix="次" tone="primary" />
        <StatBadge
          label="生效不合格"
          value={totals.unqualified}
          suffix="次"
          tone={totals.unqualified > 0 ? 'danger' : 'success'}
          tip="按生效结论统计；待重算/重算失败不计入"
        />
        <StatBadge
          label="生效合格率"
          value={totals.qualifyRate}
          percent={totals.qualifyRate}
          tone="success"
          tip="生效合格份数 ÷（原值有效+已折算）份数；待重算/重算失败单列"
        />
        <StatBadge
          label="待重算/失败"
          value={totals.pending}
          suffix="份"
          tone={totals.pending > 0 ? 'warning' : 'default'}
        />
        <StatBadge label="生效平均灵敏度" value={totals.meanSensitivity} suffix="V·s/m" tone="info" />
        <StatBadge label="生效平均自噪" value={totals.meanNoise} suffix="" tone="warning" />
      </div>

      {attentionRows.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${attentionRows.length} 份结论待重算 / 重算失败：旧数据未挂标准器或标准器不可用，已单列且不计入合格率与更换口径`}
          action={
            <Space direction="vertical" size={4}>
              <Button size="small" type="primary" icon={<LinkOutlined />} onClick={() => { setAttachStandardId(undefined); setAttachOpen(true); }}>
                {selectedKeys.length > 0 ? `补挂勾选的 ${selectedKeys.length} 份` : '补挂标准器'}
              </Button>
            </Space>
          }
          description={
            <span>
              也可在每行点「重试这份」单独重出；重算只动该结论，
              <b>标准器台账不会被修改</b>。{selectedKeys.length > 0 ? '当前勾选将优先补挂。' : '未勾选时对全部待处理份补挂。'}
            </span>
          }
        />
      ) : null}

      <FilterBar
        modelValue={filterModel}
        selects={[
          {
            key: 'verdicts',
            label: '响应结论',
            options: RESPONSE_VERDICTS.map((verdict) => ({ label: verdict, value: verdict })),
          },
          {
            key: 'instrumentTypes',
            label: '仪器类型',
            options: INSTRUMENT_TYPES.map((type) => ({ label: type, value: type })),
          },
        ]}
        hasSwitch
        switchLabel="仅看不合格记录"
        switchValue={filter.onlyOverdue}
        keywordPlaceholder="搜索型号 / 序列号 / 台站 / 标定人 / 标准器 / 证书号"
        onChange={handleFilterChange}
        onReset={handleReset}
        extra={
          <Space size={6} wrap>
            <Select
              mode="multiple"
              size="small"
              allowClear
              style={{ minWidth: 220 }}
              placeholder="生效口径状态"
              value={filter.effectStatuses}
              onChange={(values) => {
                dispatch(patchFilter({ effectStatuses: values as EffectStatus[] }));
                const params = new URLSearchParams(searchParams);
                if (values.length > 0) params.set('effect', values.join(','));
                else params.delete('effect');
                setSearchParams(params, { replace: true });
              }}
              options={EFFECT_STATUSES.map((status) => ({
                label: status,
                value: status,
              }))}
            />
            <span className="gb-hint">批量改原始结论：</span>
            {RESPONSE_VERDICTS.map((verdict) => (
              <Button key={verdict} size="small" onClick={() => void handleBulkVerdict(verdict)}>
                {verdict}
              </Button>
            ))}
          </Space>
        }
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={calibrations.length === 0 ? '还没有标定记录' : '没有符合条件的标定记录'}
          description="先到「台站仪器」页登记仪器，再按次录入灵敏度与自噪，即可形成可追溯的标定台账。"
          actionText="新增标定记录"
          secondaryText="重置筛选"
          onAction={openCreate}
          onSecondary={handleReset}
        />
      ) : (
        <Table
          rowKey={(item) => item.row.id}
          className="gb-table-compact"
          dataSource={rows}
          pagination={{ pageSize: 12, showSizeChanger: false }}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: (keys) => setSelectedKeys(keys as string[]),
          }}
          columns={[
            {
              title: '仪器',
              width: 200,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div>
                    {item.instrumentModel} <Tag>{item.instrumentType}</Tag>
                  </div>
                  <div className="gb-hint gb-mono">{item.serialNo}</div>
                </div>
              ),
            },
            {
              title: '台站 / 台阵',
              width: 180,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div className="gb-mono">{item.stationCode}</div>
                  <div className="gb-hint">{item.arrayName}</div>
                </div>
              ),
            },
            { title: '标定日期', dataIndex: ['row', 'date'], width: 110, className: 'gb-mono' },
            {
              title: '标准器 / 溯源证书',
              width: 210,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div className="gb-hint">{item.standardName}</div>
                  {item.row.traceCertNo ? (
                    <div className="gb-mono gb-hint">证书 {item.row.traceCertNo}</div>
                  ) : (
                    <div className="gb-danger gb-hint">无有效挂接</div>
                  )}
                </div>
              ),
            },
            {
              title: '原值（留档）',
              width: 140,
              align: 'right',
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <span className="gb-mono gb-hint">
                    {item.row.sensitivity} / {item.row.selfNoise}
                  </span>
                  <div className="gb-hint">
                    原始结论：
                    <QualifyTag verdict={item.row.responseVerdict} size="small" plain />
                  </div>
                </div>
              ),
            },
            {
              title: '生效值（统计口径）',
              width: 200,
              align: 'right',
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  {isEffectUsable(item.row.effectStatus) && item.row.effectiveSensitivity !== null ? (
                    <>
                      <span className="gb-mono">
                        {item.row.effectiveSensitivity} / {item.row.effectiveSelfNoise}
                      </span>
                      <div>
                        <QualifyTag
                          verdict={item.row.effectiveVerdict}
                          sensitivity={item.row.effectiveSensitivity}
                          selfNoise={item.row.effectiveSelfNoise ?? undefined}
                          size="small"
                        />
                      </div>
                      <div className="gb-hint">
                        相对上次 {item.delta.comparable ? `${item.delta.percent}%` : '首次'}
                      </div>
                    </>
                  ) : (
                    <div>
                      <Tag color={EFFECT_STATUS_COLOR[item.row.effectStatus]}>{item.row.effectStatus}</Tag>
                      <div className="gb-danger gb-hint" style={{ maxWidth: 180 }}>
                        {item.row.recompute?.lastError ?? '未折算，先单列'}
                      </div>
                    </div>
                  )}
                </div>
              ),
            },
            {
              title: '生效依据',
              width: 110,
              render: (_: unknown, item: CalibrationRow) => (
                <Space direction="vertical" size={2}>
                  <Tag color={EFFECT_STATUS_COLOR[item.row.effectStatus]}>{item.row.effectStatus}</Tag>
                  {item.row.effectBasis ? (
                    <Tooltip
                      title={
                        <div style={{ maxWidth: 320 }}>
                          <div>{item.row.effectBasis.reason}</div>
                          <div>标准器：{item.row.effectBasis.standardSerialNo}</div>
                          <div>
                            证书：{item.row.effectBasis.certNo}（{item.row.effectBasis.certConfirmDate} 确认，有效期至{' '}
                            {item.row.effectBasis.certValidUntil}）
                          </div>
                          <div>修正因子：{item.row.effectBasis.correctionFactor}</div>
                        </div>
                      }
                    >
                      <Button size="small" type="link" onClick={() => setBasisOf(item.row)}>
                        查看依据
                      </Button>
                    </Tooltip>
                  ) : null}
                </Space>
              ),
            },
            {
              title: '标定人 / 机构',
              width: 150,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div>{item.row.operator || '未署名'}</div>
                  <div className="gb-hint">{item.row.agency || '未填写机构'}</div>
                </div>
              ),
            },
            { title: '备注', dataIndex: ['row', 'remark'], ellipsis: true, width: 120 },
            {
              title: '操作',
              width: 210,
              fixed: 'right',
              render: (_: unknown, item: CalibrationRow) => (
                <Space size={6} wrap>
                  <Button size="small" onClick={() => setTrendInstrumentId(item.row.instrumentId)}>
                    趋势
                  </Button>
                  {!isEffectUsable(item.row.effectStatus) ? (
                    <Tooltip title="重出失败后只重试这一份，标准器台账不动">
                      <Button size="small" type="primary" icon={<RetweetOutlined />} onClick={() => void retryOne(item.row.id)}>
                        重试这份
                      </Button>
                    </Tooltip>
                  ) : null}
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(item.row)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除标定记录"
                    description={`确认删除 ${item.row.date} 的标定记录？`}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void dispatch(removeCalibration(item.row.id))
                        .unwrap()
                        .then(() => message.success('标定记录已删除'))
                    }
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          scroll={{ x: 1500 }}
        />
      )}

      <Card
        className="gb-panel"
        size="small"
        title="灵敏度趋势"
        extra={
          <Select
            style={{ width: 260 }}
            placeholder="选择仪器"
            value={trendRows.targetId ?? undefined}
            onChange={(value) => setTrendInstrumentId(value)}
            options={instruments.map((instrument) => ({
              label: `${instrument.model}（${instrument.serialNo}）`,
              value: instrument.id,
            }))}
          />
        }
      >
        {trendChart.dots.length === 0 ? (
          <EmptyPanel title="暂无可绘制的趋势" description="该仪器还没有标定记录。" compact />
        ) : (
          <>
            <svg viewBox="0 0 380 220" className="gb-chart">
              <line x1="58" y1="190" x2="352" y2="190" stroke="#b9c6d4" />
              <line x1="58" y1="20" x2="58" y2="190" stroke="#b9c6d4" />
              <text x="8" y="24" className="gb-chart-axis">
                {round(trendChart.max, 0)}
              </text>
              <text x="8" y="194" className="gb-chart-axis">
                {round(trendChart.min, 0)}
              </text>
              <polyline points={trendChart.line} fill="none" stroke="#1e3a5f" strokeWidth="2" />
              {trendChart.dots.map((dot) => (
                <g key={dot.id}>
                  <circle cx={dot.cx} cy={dot.cy} r="4.5" fill="#7fd1e8" stroke="#1e3a5f" />
                  <text x={dot.cx - 22} y={220 - 4} className="gb-chart-axis">
                    {dot.date.slice(2)}
                  </text>
                </g>
              ))}
            </svg>
            <p className="gb-hint">
              纵轴为<b>生效灵敏度</b>（V·s/m），横轴为标定日期；共 {trendChart.dots.length} 次标定。
              生效值已按所挂标准器的修正因子折算，变化超过 5% 以红色提示；待重算/重算失败的份不参与连线统计。
            </p>
          </>
        )}
      </Card>

      <p className="gb-hint">
        需要处理超期或不合格仪器？前往
        <Button type="link" size="small" onClick={() => navigate('/replacements')}>
          合格评定与更换
        </Button>
        登记更换并跟踪到复核闭环。
      </p>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑标定记录' : '新增标定记录'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存并重算生效值' : '保存并折算生效值'}
        width={680}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="instrumentId" label="被标定仪器" rules={[{ required: true, message: '请选择仪器' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={instruments.map((instrument) => {
                const info = instrumentIndex.get(instrument.id);
                return {
                  label: `${info?.arrayName ?? ''} / ${info?.stationCode ?? ''} · ${instrument.model}（${instrument.serialNo}）`,
                  value: instrument.id,
                };
              })}
              onChange={(value: string) => {
                const instrument = instruments.find((row) => row.id === value);
                const range = SENSITIVITY_RANGE[instrument?.type ?? '宽频带'];
                form.setFieldValue('sensitivity', round((range.min + range.max) / 2, 2));
                const date = form.getFieldValue('date') ?? dayjs();
                form.setFieldValue(
                  'standardId',
                  suggestStandardId(instrument?.type ?? '宽频带', date)
                );
              }}
            />
          </Form.Item>

          <Form.Item
            name="standardId"
            label="比对所用标准器（计量站台账，挂“当时那台”）"
            extra="若该标准器在标定日已过校准有效期，原值会留档，系统按其最近溯源证书的修正因子另算生效值并标出依据。"
          >
            <Select
              allowClear
              placeholder="选择当时比对使用的标准器（不选将列为待重算，先单列）"
              options={standards.map((standard) => {
                const today = new Date().toISOString().slice(0, 10);
                const status = standard.state === '停用' ? '已停用' : `校准${caliberStatusAt(standard, today)}`;
                return {
                  label: `${standard.name} ${standard.serialNo}（${standard.ownerAgency} · ${status}）`,
                  value: standard.id,
                };
              })}
            />
          </Form.Item>

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="date" label="标定日期" rules={[{ required: true }]}>
                <DatePicker
                  style={{ width: '100%' }}
                  onChange={(value) => {
                    const instrumentId = form.getFieldValue('instrumentId') as string | undefined;
                    const instrument = instruments.find((row) => row.id === instrumentId);
                    if (instrument && value) {
                      form.setFieldValue('standardId', suggestStandardId(instrument.type, value));
                    }
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="responseVerdict"
                label="原始响应结论（留档）"
                tooltip="以标定报告为准的原始结论，永不覆盖；生效结论由原始读数 × 标准器修正因子自动折算"
                rules={[{ required: true }]}
              >
                <Select options={RESPONSE_VERDICTS.map((verdict) => ({ label: verdict, value: verdict }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="sensitivity" label="原始灵敏度读数 (V·s/m)" rules={[{ required: true }]}>
                <InputNumber min={0} max={100000} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="selfNoise" label={`原始自噪读数（限值 ${SELF_NOISE_LIMIT}）`} rules={[{ required: true }]}>
                <InputNumber min={0} max={100} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="operator" label="标定人" rules={[{ required: true, message: '请填写标定人' }]}>
                <Input maxLength={20} placeholder="如：陈立群" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="agency" label="标定机构">
                <Input maxLength={40} placeholder="如：省地震局计量站" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：响应曲线平滑 / 自噪接近上限" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={basisOf !== null}
        title="生效值判定依据"
        onCancel={() => setBasisOf(null)}
        footer={null}
        width={560}
      >
        {basisOf?.effectBasis ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Tag color={EFFECT_STATUS_COLOR[basisOf.effectStatus]}>{basisOf.effectStatus}</Tag>
            <p style={{ margin: 0 }}>{basisOf.effectBasis.reason}</p>
            <Table
              size="small"
              pagination={false}
              rowKey="label"
              dataSource={[
                { label: '标准器编号', value: basisOf.effectBasis.standardSerialNo },
                { label: '溯源证书号', value: basisOf.effectBasis.certNo },
                { label: '校准确认日期', value: basisOf.effectBasis.certConfirmDate },
                { label: '校准有效期至', value: basisOf.effectBasis.certValidUntil },
                { label: '比对当日校准有效', value: basisOf.effectBasis.caliberValidAtCalibration ? '是' : '否（过期折算）' },
                { label: '修正因子', value: String(basisOf.effectBasis.correctionFactor) },
                { label: '原始灵敏度', value: String(basisOf.sensitivity) },
                { label: '生效灵敏度', value: String(basisOf.effectiveSensitivity ?? '—') },
                { label: '生效结论', value: basisOf.effectiveVerdict },
              ]}
              columns={[
                { title: '项', dataIndex: 'label', width: 160 },
                { title: '值', dataIndex: 'value' },
              ]}
            />
          </Space>
        ) : (
          <p className="gb-hint">{basisOf?.recompute?.lastError ?? '该结论尚无生效依据，请重试或补挂标准器。'}</p>
        )}
      </Modal>

      <Modal
        open={attachOpen}
        title="为待重算结论补挂标准器"
        onCancel={() => setAttachOpen(false)}
        onOk={() => void submitAttach()}
        confirmLoading={submitting}
        okText="补挂并重算"
        width={520}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`将按标定日期把所选标准器挂到${selectedKeys.length > 0 ? `勾选的 ${selectedKeys.length} 份` : `全部 ${attentionRows.length} 份待处理`}结论并重算；标准器台账不改动。`}
        />
        <Select
          showSearch
          style={{ width: '100%' }}
          placeholder="选择当时在用的标准器"
          value={attachStandardId}
          onChange={setAttachStandardId}
          optionFilterProp="label"
          options={standards.map((standard) => ({
            label: `${standard.name} ${standard.serialNo}（${standard.ownerAgency}）`,
            value: standard.id,
          }))}
        />
      </Modal>
    </div>
  );
}
