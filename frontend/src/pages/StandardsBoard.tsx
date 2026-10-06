/**
 * 计量站侧：/standards 标准器与溯源证书台账。
 * 只管理：标准器、校准有效期、溯源证书（含修正因子）。
 * 续证 / 停用 / 删除证书后，台网中心挂接该标准器的结论自动重算一版（只读台网数据）。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
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
  SafetyCertificateOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  addCertificate,
  createStandard,
  removeCertificate,
  removeStandard,
  selectStandards,
  setStandardState,
  updateStandard,
} from '@/stores/standardSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import {
  STANDARD_SCOPE_TYPES,
  STANDARD_STATES,
  standardCurrentStatus,
  type CalibrationStandard,
  type StandardDraft,
  type TraceCertificate,
} from '@/types/standard';
import { recomputeByStandard } from '@/utils/recompute';

interface StandardFormValues {
  name: string;
  model: string;
  serialNo: string;
  ownerAgency: string;
  scopeTypes: string[];
  inUseFrom: dayjs.Dayjs;
  state: CalibrationStandard['state'];
  remark: string;
}

interface CertFormValues {
  certNo: string;
  issuedBy: string;
  confirmDate: dayjs.Dayjs;
  validUntil: dayjs.Dayjs;
  correctionFactor: number;
  uncertaintyPct: number;
  remark: string;
}

const todayStr = (): string => new Date().toISOString().slice(0, 10);

export default function StandardsBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const standards = useAppSelector(selectStandards);
  const calibrations = useAppSelector(selectCalibrations);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [certStandardId, setCertStandardId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<StandardFormValues>();
  const [certForm] = Form.useForm<CertFormValues>();

  const usageCount = useMemo(() => {
    const map = new Map<string, number>();
    calibrations.forEach((row) => {
      if (row.standardId) map.set(row.standardId, (map.get(row.standardId) ?? 0) + 1);
    });
    return map;
  }, [calibrations]);

  const rows = useMemo(() => {
    const today = todayStr();
    return standards
      .map((standard) => ({ standard, ...standardCurrentStatus(standard, today) }))
      .sort((a, b) => {
        const rank: Record<string, number> = { 过期: 0, 未建标: 0, 有效: 1, 停用: 2 };
        return (rank[a.status] ?? 1) - (rank[b.status] ?? 1);
      });
  }, [standards]);

  const totals = useMemo(() => {
    const expired = rows.filter((row) => row.status === '过期').length;
    const expiringSoon = rows.filter(
      (row) => row.status === '有效' && row.daysToExpiry !== null && row.daysToExpiry <= 60
    ).length;
    const certs = standards.reduce((sum, row) => sum + row.certificates.length, 0);
    return { total: standards.length, expired, expiringSoon, certs };
  }, [rows, standards]);

  const openCreate = () => {
    setEditingId(null);
    form.setFieldsValue({
      name: '便携式地震计校准装置',
      model: '',
      serialNo: '',
      ownerAgency: '省地震局计量站',
      scopeTypes: ['宽频带'],
      inUseFrom: dayjs(),
      state: '在役',
      remark: '',
    });
    setModalOpen(true);
  };

  const openEdit = (standard: CalibrationStandard) => {
    setEditingId(standard.id);
    form.setFieldsValue({
      name: standard.name,
      model: standard.model,
      serialNo: standard.serialNo,
      ownerAgency: standard.ownerAgency,
      scopeTypes: standard.scopeTypes,
      inUseFrom: dayjs(standard.inUseFrom),
      state: standard.state,
      remark: standard.remark,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const draft: StandardDraft = {
        name: values.name.trim(),
        model: values.model.trim(),
        serialNo: values.serialNo.trim(),
        ownerAgency: values.ownerAgency.trim(),
        scopeTypes: values.scopeTypes,
        inUseFrom: values.inUseFrom.format('YYYY-MM-DD'),
        inUseUntil: '',
        state: values.state,
        remark: values.remark?.trim() ?? '',
      };
      if (editingId) {
        await dispatch(updateStandard({ id: editingId, patch: draft })).unwrap();
        message.success('标准器台账已更新');
      } else {
        await dispatch(createStandard(draft)).unwrap();
        message.success('标准器已登记，可继续登记溯源证书');
      }
      setModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const openCert = (standardId: string) => {
    setCertStandardId(standardId);
    certForm.setFieldsValue({
      certNo: '',
      issuedBy: '国家地震计量站',
      confirmDate: dayjs(),
      validUntil: dayjs().add(2, 'year'),
      correctionFactor: 1,
      uncertaintyPct: 1,
      remark: '',
    });
  };

  const submitCert = async () => {
    if (!certStandardId) return;
    const values = await certForm.validateFields();
    setSubmitting(true);
    try {
      const certificate: TraceCertificate = {
        certNo: values.certNo.trim(),
        issuedBy: values.issuedBy.trim(),
        confirmDate: values.confirmDate.format('YYYY-MM-DD'),
        validFrom: values.confirmDate.format('YYYY-MM-DD'),
        validUntil: values.validUntil.format('YYYY-MM-DD'),
        correctionFactor: Number(values.correctionFactor),
        uncertaintyPct: Number(values.uncertaintyPct),
        remark: values.remark?.trim() ?? '',
      };
      await dispatch(addCertificate({ standardId: certStandardId, certificate })).unwrap();
      message.success('溯源证书已登记，挂接结论已重算');
      setCertStandardId(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '证书登记失败');
    } finally {
      setSubmitting(false);
    }
  };

  const forceRecompute = async (standardId: string) => {
    const affected = await recomputeByStandard(standardId);
    message.success(`已让挂接该标准器的 ${affected} 份结论按当前证书重算一版`);
  };

  const certStandard = standards.find((row) => row.id === certStandardId) ?? null;

  return (
    <div style={{ display: 'flex', 'flexDirection': 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            计量标准器与溯源证书（计量站）
          </Typography.Title>
          <p className="gb-hint">
            本页只管标准器、校准有效期与溯源证书（含灵敏度修正因子）。标定记录、响应结论与更换提醒归台网中心；
            续证或标准器过期后，台网中心挂接它的结论会<b>保留原值、另算生效值并标出依据</b>，合格率/更换/导出随之换口径。
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          登记标准器
        </Button>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="标准器" value={totals.total} suffix="台" tone="primary" />
        <StatBadge label="校准已过期" value={totals.expired} suffix="台" tone={totals.expired ? 'danger' : 'success'}
          tip="今天不在任一溯源证书有效期内（在役标准器）" />
        <StatBadge label="60 天内到期" value={totals.expiringSoon} suffix="台" tone={totals.expiringSoon ? 'warning' : 'success'} />
        <StatBadge label="溯源证书" value={totals.certs} suffix="张" tone="info" />
      </div>

      {totals.expired > 0 ? (
        <Alert
          type="error"
          showIcon
          icon={<SafetyCertificateOutlined />}
          message={`有 ${totals.expired} 台标准器校准已过期；挂接它们的历史结论已保留原值并按最近证书折算生效值，请尽快送检续证`}
        />
      ) : (
        <Alert type="success" showIcon icon={<SafetyCertificateOutlined />} message="在役标准器校准均在有效期内" />
      )}

      {standards.length === 0 ? (
        <EmptyPanel
          title="还没有计量标准器"
          description="先登记标准器及其溯源证书（校准有效期、修正因子），台网中心录入标定时即可挂“当时那台”。"
          actionText="登记标准器"
          onAction={openCreate}
        />
      ) : (
        rows.map(({ standard, status, cert, daysToExpiry }) => {
          const used = usageCount.get(standard.id) ?? 0;
          return (
            <Card
              key={standard.id}
              className="gb-panel"
              size="small"
              title={
                <Space wrap>
                  <span>{standard.name}</span>
                  <Tag color="blue">{standard.model}</Tag>
                  <span className="gb-mono gb-hint">{standard.serialNo}</span>
                  <Tag color={standard.state === '停用' ? 'default' : status === '过期' ? 'red' : 'green'}>
                    {standard.state === '停用' ? '已停用' : `校准${status}`}
                  </Tag>
                </Space>
              }
              extra={
                <Space wrap>
                  <Button size="small" onClick={() => openCert(standard.id)}>
                    登记证书
                  </Button>
                  <Tooltip title="按当前证书让挂接结论重算一版（原值留档）">
                    <Button size="small" icon={<ReloadOutlined />} onClick={() => void forceRecompute(standard.id)}>
                      重算挂接结论
                    </Button>
                  </Tooltip>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(standard)}>
                    编辑
                  </Button>
                  {used === 0 ? (
                    <Popconfirm
                      title="删除标准器"
                      description="仅未被任何标定挂接的标准器可删除。确认删除？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() =>
                        void dispatch(removeStandard(standard.id)).unwrap().then(() => message.success('标准器已删除'))
                      }
                    >
                      <Button size="small" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  ) : null}
                </Space>
              }
            >
              <Space wrap size={[8, 8]} style={{ marginBottom: 10 }}>
                <Tag>保管：{standard.ownerAgency}</Tag>
                <Tag>适用：{standard.scopeTypes.join(' / ')}</Tag>
                <Tag>启用 {standard.inUseFrom}{standard.inUseUntil ? ` ~ ${standard.inUseUntil}` : ' 起'}</Tag>
                <Tag>被 {used} 份标定挂接</Tag>
                {status === '有效' && daysToExpiry !== null ? (
                  <Tag color={daysToExpiry <= 60 ? 'orange' : 'green'}>
                    当前证书 {cert?.certNo}，{daysToExpiry >= 0 ? `剩余 ${daysToExpiry} 天` : '已过期'}
                  </Tag>
                ) : standard.state === '在役' ? (
                  <Tag color="red">无有效证书（{standard.certificates.length > 0 ? '已过期，结论按最近证书折算' : '未建标，结论待重算'}）</Tag>
                ) : null}
                {standard.state === '在役' ? (
                  <Button
                    size="small"
                    danger
                    onClick={() =>
                      void dispatch(setStandardState({ id: standard.id, state: '停用' }))
                        .unwrap()
                        .then(() => message.success('标准器已停用，挂接结论已重算'))
                    }
                  >
                    停用
                  </Button>
                ) : (
                  <Button
                    size="small"
                    onClick={() =>
                      void dispatch(setStandardState({ id: standard.id, state: '在役' }))
                        .unwrap()
                        .then(() => message.success('标准器已重新启用'))
                    }
                  >
                    重新启用
                  </Button>
                )}
              </Space>

              <Table
                rowKey={(row) => row.certNo}
                size="small"
                className="gb-table-compact"
                pagination={false}
                dataSource={[...standard.certificates].sort((a, b) => b.validUntil.localeCompare(a.validUntil))}
                locale={{ emptyText: '尚无溯源证书，挂接该标准器的结论将“待重算”单列' }}
                columns={[
                  { title: '证书号', dataIndex: 'certNo', width: 150, className: 'gb-mono' },
                  { title: '溯源机构', dataIndex: 'issuedBy', width: 160 },
                  { title: '确认日期', dataIndex: 'confirmDate', width: 110, className: 'gb-mono' },
                  {
                    title: '有效期',
                    width: 200,
                    render: (_: unknown, row: TraceCertificate) => (
                      <span className="gb-mono">
                        {row.validFrom} ~ {row.validUntil}
                      </span>
                    ),
                  },
                  {
                    title: '修正因子',
                    dataIndex: 'correctionFactor',
                    width: 100,
                    align: 'right',
                    render: (value: number) => <span className="gb-mono">{value}</span>,
                  },
                  { title: '不确定度', dataIndex: 'uncertaintyPct', width: 90, align: 'right', render: (v: number) => `${v}%` },
                  {
                    title: '当前状态',
                    width: 110,
                    render: (_: unknown, row: TraceCertificate) => {
                      const today = todayStr();
                      const current = today >= row.validFrom && today <= row.validUntil;
                      return <Tag color={current ? 'green' : 'red'}>{current ? '生效中' : '已失效'}</Tag>;
                    },
                  },
                  { title: '备注', dataIndex: 'remark', ellipsis: true },
                  {
                    title: '操作',
                    width: 80,
                    render: (_: unknown, row: TraceCertificate) => (
                      <Popconfirm
                        title="删除该溯源证书？"
                        description="删除后挂接结论会立即重算（可能转为待重算/折算）。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() =>
                          void dispatch(removeCertificate({ standardId: standard.id, certNo: row.certNo }))
                            .unwrap()
                            .then(() => message.success('证书已删除，挂接结论已重算'))
                        }
                      >
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    ),
                  },
                ]}
              />
            </Card>
          );
        })
      )}

      <Modal
        open={modalOpen}
        title={editingId ? '编辑标准器台账' : '登记计量标准器'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存修改' : '保存'}
        width={620}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="name" label="标准器名称" rules={[{ required: true, message: '请填写名称' }]}>
                <Input maxLength={40} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
                <Input maxLength={40} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="serialNo" label="出厂编号" rules={[{ required: true, message: '请填写出厂编号' }]}>
                <Input maxLength={40} placeholder="如：GSB2100-省级-07" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="ownerAgency" label="建标 / 保管机构" rules={[{ required: true, message: '请填写保管机构' }]}>
                <Input maxLength={40} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="scopeTypes" label="适用仪器类型" rules={[{ required: true, message: '请选择适用类型' }]}>
                <Select mode="multiple" options={STANDARD_SCOPE_TYPES.map((value) => ({ label: value, value }))} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="inUseFrom" label="启用日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="state" label="状态" rules={[{ required: true }]}>
                <Select options={STANDARD_STATES.map((value) => ({ label: value, value }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={120} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={certStandardId !== null}
        title={`登记溯源证书${certStandard ? ` · ${certStandard.serialNo}` : ''}`}
        onCancel={() => setCertStandardId(null)}
        onOk={() => void submitCert()}
        confirmLoading={submitting}
        okText="保存并重算挂接结论"
        width={620}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="证书保存后，台网中心所有挂接该标准器的结论会立即重算：有效期内取原值，已过期按本修正因子折算生效值。"
        />
        <Form form={certForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="certNo" label="证书编号" rules={[{ required: true, message: '请填写证书编号' }]}>
                <Input maxLength={40} placeholder="如：JL-2024-0320" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="issuedBy" label="溯源机构" rules={[{ required: true, message: '请填写溯源机构' }]}>
                <Input maxLength={40} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="confirmDate" label="校准确认日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="validUntil" label="校准有效期止" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="correctionFactor"
                label="灵敏度修正因子（生效值 = 原值 × 因子）"
                rules={[{ required: true }]}
              >
                <InputNumber min={0.01} max={10} step={0.001} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="uncertaintyPct" label="扩展不确定度（%）">
                <InputNumber min={0} max={100} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={120} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
