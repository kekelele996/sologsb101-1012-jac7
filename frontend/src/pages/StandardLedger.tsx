/**
 * 模块 6：/standards 标准器台账（计量站管辖）
 * 维护标准器名称、型号、序列号、溯源证书号、校准日期与有效期至。
 * 台网中心的标定记录挂接标准器后另算生效结论；标准器过期不影响历史原值。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  createStandard,
  removeStandard,
  selectStandards,
  updateStandard,
} from '@/stores/standardSlice';
import {
  createEmptyStandardDraft,
  isStandardExpired,
  standardExpireInDays,
  type Standard,
  type StandardDraft,
} from '@/types/standard';
import { initDatabase } from '@/utils/db';

interface StandardFormValues {
  name: string;
  model: string;
  serialNo: string;
  certificateNo: string;
  calibrationDate: dayjs.Dayjs | null;
  validUntil: dayjs.Dayjs | null;
  agency: string;
  remark: string;
}

type StatusFilter = 'all' | 'valid' | 'expired';

export default function StandardLedger() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const standards = useAppSelector(selectStandards);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [form] = Form.useForm<StandardFormValues>();

  useEffect(() => {
    if (standards.length === 0) void initDatabase();
  }, [standards.length]);

  const rows = useMemo(() => {
    const now = Date.now();
    return standards
      .map((standard) => {
        const expired = isStandardExpired(standard, now);
        const expireInDays = standardExpireInDays(standard, now);
        return { standard, expired, expireInDays };
      })
      .filter((item) => {
        if (statusFilter === 'valid' && item.expired) return false;
        if (statusFilter === 'expired' && !item.expired) return false;
        const kw = keyword.trim();
        if (kw.length > 0) {
          const haystack = `${item.standard.name}${item.standard.model}${item.standard.serialNo}${item.standard.certificateNo}${item.standard.agency}`;
          if (!haystack.includes(kw)) return false;
        }
        return true;
      })
      .sort((a, b) => b.standard.validUntil.localeCompare(a.standard.validUntil));
  }, [standards, keyword, statusFilter]);

  const totals = useMemo(() => {
    const now = Date.now();
    const expired = standards.filter((s) => isStandardExpired(s, now)).length;
    return { total: standards.length, valid: standards.length - expired, expired };
  }, [standards]);

  const filterModel: FilterModel = {
    keyword,
    states: statusFilter === 'all' ? [] : [statusFilter],
    arrayIds: [],
  };

  const openCreate = () => {
    setEditingId(null);
    const draft = createEmptyStandardDraft();
    form.setFieldsValue({
      ...draft,
      calibrationDate: dayjs(draft.calibrationDate),
      validUntil: draft.validUntil ? dayjs(draft.validUntil) : null,
    });
    setModalOpen(true);
  };

  const openEdit = (standard: Standard) => {
    setEditingId(standard.id);
    form.setFieldsValue({
      name: standard.name,
      model: standard.model,
      serialNo: standard.serialNo,
      certificateNo: standard.certificateNo,
      calibrationDate: dayjs(standard.calibrationDate),
      validUntil: dayjs(standard.validUntil),
      agency: standard.agency,
      remark: standard.remark,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const payload: StandardDraft = {
        name: values.name.trim(),
        model: values.model.trim(),
        serialNo: values.serialNo.trim(),
        certificateNo: values.certificateNo.trim(),
        calibrationDate: values.calibrationDate ? values.calibrationDate.format('YYYY-MM-DD') : '',
        validUntil: values.validUntil ? values.validUntil.format('YYYY-MM-DD') : '',
        agency: values.agency?.trim() ?? '',
        remark: values.remark?.trim() ?? '',
      };
      if (editingId) {
        await dispatch(updateStandard({ id: editingId, patch: payload })).unwrap();
        message.success('标准器台账已更新');
      } else {
        await dispatch(createStandard(payload)).unwrap();
        message.success('标准器台账已新增');
      }
      setModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFilterChange = (next: FilterModel) => {
    setKeyword(next.keyword);
    const states = (next.states as string[]) ?? [];
    setStatusFilter(states.length === 0 ? 'all' : (states[0] as StatusFilter));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            标准器台账
          </Typography.Title>
          <p className="gb-hint">
            计量站管辖：维护标准器与校准有效期、溯源证书。台网中心的标定记录挂接标准器后另算生效结论；标准器过期不影响历史原值。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void initDatabase()}>
            补齐演示数据
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增标准器
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="标准器总数" value={totals.total} suffix="台" tone="primary" />
        <StatBadge label="有效" value={totals.valid} suffix="台" tone="success" />
        <StatBadge
          label="已过期"
          value={totals.expired}
          suffix="台"
          tone={totals.expired > 0 ? 'danger' : 'success'}
        />
      </div>

      <FilterBar
        modelValue={filterModel}
        selects={[
          {
            key: 'states',
            label: '有效期状态',
            options: [
              { label: '全部', value: 'all' },
              { label: '有效', value: 'valid' },
              { label: '已过期', value: 'expired' },
            ],
          },
        ]}
        keywordPlaceholder="搜索名称 / 型号 / 序列号 / 证书号"
        onChange={handleFilterChange}
        onReset={() => {
          setKeyword('');
          setStatusFilter('all');
        }}
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={standards.length === 0 ? '还没有标准器台账' : '没有符合条件的标准器'}
          description="新增标准器并填写溯源证书与有效期，台网中心标定记录即可挂接并自动判定生效结论。"
          actionText="新增标准器"
          secondaryText="重置筛选"
          onAction={openCreate}
          onSecondary={() => {
            setKeyword('');
            setStatusFilter('all');
          }}
        />
      ) : (
        <Table
          rowKey={(item) => item.standard.id}
          className="gb-table-compact"
          dataSource={rows}
          pagination={{ pageSize: 12, showSizeChanger: false }}
          rowClassName={(item) => (item.expired ? 'gb-row-danger' : '')}
          columns={[
            {
              title: '标准器',
              width: 220,
              render: (_: unknown, item) => (
                <div>
                  <div>
                    {item.standard.name} <Tag>{item.standard.model}</Tag>
                  </div>
                  <div className="gb-hint gb-mono">{item.standard.serialNo || '未填序列号'}</div>
                </div>
              ),
            },
            { title: '溯源证书号', dataIndex: ['standard', 'certificateNo'], width: 160, className: 'gb-mono' },
            { title: '校准日期', dataIndex: ['standard', 'calibrationDate'], width: 120, className: 'gb-mono' },
            {
              title: '有效期至',
              width: 170,
              render: (_: unknown, item) => (
                <div>
                  <div className="gb-mono">{item.standard.validUntil || '未填'}</div>
                  {item.standard.validUntil ? (
                    <div className={item.expired ? 'gb-danger gb-hint' : 'gb-hint'}>
                      {item.expired ? `已过期 ${Math.abs(item.expireInDays)} 天` : `剩余 ${item.expireInDays} 天`}
                    </div>
                  ) : null}
                </div>
              ),
            },
            { title: '计量机构', dataIndex: ['standard', 'agency'], width: 180 },
            {
              title: '状态',
              width: 100,
              render: (_: unknown, item) =>
                item.expired ? <Tag color="red">已过期</Tag> : <Tag color="green">有效</Tag>,
            },
            { title: '备注', dataIndex: ['standard', 'remark'], ellipsis: true },
            {
              title: '操作',
              width: 160,
              render: (_: unknown, item) => (
                <Space size={6}>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(item.standard)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除标准器"
                    description={`确认删除标准器「${item.standard.name}」？删除后挂接它的标定记录将变为未挂接。`}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void dispatch(removeStandard(item.standard.id))
                        .unwrap()
                        .then(() => message.success('标准器台账已删除'))
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
        />
      )}

      <Card className="gb-panel" size="small" title="标准器与生效结论口径说明">
        <p className="gb-hint" style={{ marginBottom: 8 }}>
          标准器由计量站管辖，台网中心不改动台账。标定记录挂接标准器后，按标定日期判定：
        </p>
        <ul className="gb-hint" style={{ paddingLeft: 20, marginBottom: 0 }}>
          <li>标定时标准器在有效期内 → 维持原响应结论（合格 / 不合格）</li>
          <li>标定时标准器已过期 → 生效结论判为「依据失效」，并标出依据</li>
          <li>未挂标准器 → 单列展示，结论无有效依据</li>
        </ul>
      </Card>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑标准器' : '新增标准器'}
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
                <Input maxLength={40} placeholder="如：标准振动台" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
                <Input maxLength={40} placeholder="如：ZD-3B" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="serialNo" label="序列号">
                <Input maxLength={60} placeholder="如：ZD3B-2023-02" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="certificateNo" label="溯源证书号">
                <Input maxLength={60} placeholder="如：JL2023-0892" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="calibrationDate" label="校准日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="validUntil" label="有效期至" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="agency" label="计量机构">
            <Input maxLength={40} placeholder="如：省计量科学研究院" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：宽频带与短周期标定主用" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
