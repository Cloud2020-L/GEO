import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Dialog, Form, Input, MessagePlugin, Row, Space, Table, Tag, Textarea } from 'tdesign-react';
import { RefreshIcon, AddIcon } from 'tdesign-icons-react';
import { createTask, listTasks, AnalysisTaskRow, TaskCreateRequest } from 'services/zggeo-api';
import { gradeColor } from '../common';

const { FormItem } = Form;

const RecheckTasks: React.FC = () => {
  const [tasks, setTasks] = useState<AnalysisTaskRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<AnalysisTaskRow | null>(null);
  const [form, setForm] = useState({ project_name: '', domain: '', keywords: '', urls: '', pasted_text: '' });

  const fetchData = async () => {
    setLoading(true);
    try {
      setTasks(await listTasks({ latest_only: false }));
    } catch (err: any) {
      MessagePlugin.error(`拉取复测任务失败：${err?.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const rows = useMemo(() => tasks.filter((t) => t.report_id || t.status === 'completed').slice(0, 40), [tasks]);
  const stats = useMemo(() => {
    const completed = rows.filter((t) => t.status === 'completed').length;
    const avg = rows.length
      ? Math.round(rows.reduce((sum, t) => sum + Number(t.total_score || 0), 0) / rows.length)
      : 0;
    return { total: rows.length, completed, avg };
  }, [rows]);

  const openRecheck = (task?: AnalysisTaskRow) => {
    setSeed(task || null);
    setForm({
      project_name: task?.project_name || 'ZGEO 智改',
      domain: task?.domain || 'example.com',
      keywords: '',
      urls: task?.domain ? `https://${task.domain.replace(/^https?:\/\//, '')}` : '',
      pasted_text: '',
    });
    setOpen(true);
  };

  const submit = async () => {
    if (!form.project_name.trim() || !form.domain.trim()) {
      MessagePlugin.warning('请填写项目名和域名');
      return;
    }
    const body: TaskCreateRequest = {
      project_name: form.project_name.trim(),
      domain: form.domain.trim(),
      task_type: seed ? 'recheck-followup' : 'recheck-manual',
      keywords: form.keywords
        .split(/[\n,，]/)
        .map((x) => x.trim())
        .filter(Boolean),
      urls: form.urls
        .split(/[\n,，]/)
        .map((x) => x.trim())
        .filter(Boolean),
      pasted_text: form.pasted_text.trim() || undefined,
    };
    try {
      const res = await createTask(body);
      MessagePlugin.success(`复测任务已创建：${res.task_id.slice(0, 8)}...`);
      setOpen(false);
      setTimeout(fetchData, 800);
    } catch (err: any) {
      MessagePlugin.error(`创建复测失败：${err?.message || '未知错误'}`);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <Space direction='vertical'>
          <Space>
            <Tag theme='primary' variant='light'>
              L7 回测闭环
            </Tag>
            <Tag theme='success' variant='light'>
              复测任务
            </Tag>
          </Space>
          <div style={{ fontSize: 22, fontWeight: 700 }}>复测任务</div>
          <div style={{ color: 'var(--td-text-color-secondary)' }}>
            内容发布后 14/30/90 天复测：重新跑 ZGEO 诊断，对比 AI 可见度变化。
          </div>
        </Space>
      </Card>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={4}>
          <Metric title='复测样本' value={stats.total} />
        </Col>
        <Col xs={12} lg={4}>
          <Metric title='已完成' value={stats.completed} />
        </Col>
        <Col xs={12} lg={4}>
          <Metric title='平均分' value={stats.avg} color={gradeColor(stats.avg)} />
        </Col>
      </Row>
      <Card
        bordered
        title='复测任务池'
        actions={
          <Space>
            <Button icon={<RefreshIcon />} onClick={fetchData}>
              刷新
            </Button>
            <Button theme='primary' icon={<AddIcon />} onClick={() => openRecheck()}>
              新建复测
            </Button>
          </Space>
        }
      >
        <Table
          loading={loading}
          rowKey='id'
          data={rows}
          columns={[
            {
              colKey: 'project_name',
              title: '项目',
              cell: ({ row }) => (
                <div>
                  <b>{row.project_name}</b>
                  <div style={{ color: '#999' }}>{row.domain}</div>
                </div>
              ),
            },
            { colKey: 'task_type', title: '任务类型' },
            {
              colKey: 'status',
              title: '状态',
              cell: ({ row }) => (
                <Tag theme={row.status === 'completed' ? 'success' : 'warning'} variant='light'>
                  {row.status}
                </Tag>
              ),
            },
            {
              colKey: 'total_score',
              title: '分数',
              cell: ({ row }) => <b style={{ color: gradeColor(row.total_score) }}>{row.total_score || '-'}</b>,
            },
            {
              colKey: 'created_at',
              title: '时间',
              cell: ({ row }) => new Date(row.created_at).toLocaleString('zh-CN'),
            },
            {
              colKey: 'op',
              title: '操作',
              cell: ({ row }) => (
                <Button size='small' theme='primary' variant='outline' onClick={() => openRecheck(row)}>
                  基于此任务复测
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <Dialog
        visible={open}
        header='新建复测任务'
        onClose={() => setOpen(false)}
        onConfirm={submit}
        confirmBtn='创建复测'
      >
        <Form layout='vertical'>
          <FormItem label='项目名'>
            <Input value={form.project_name} onChange={(v) => setForm({ ...form, project_name: String(v) })} />
          </FormItem>
          <FormItem label='域名'>
            <Input value={form.domain} onChange={(v) => setForm({ ...form, domain: String(v) })} />
          </FormItem>
          <FormItem label='关键词'>
            <Textarea
              value={form.keywords}
              onChange={(v) => setForm({ ...form, keywords: String(v) })}
              autosize={{ minRows: 3, maxRows: 6 }}
            />
          </FormItem>
          <FormItem label='复测 URL'>
            <Textarea
              value={form.urls}
              onChange={(v) => setForm({ ...form, urls: String(v) })}
              autosize={{ minRows: 3, maxRows: 6 }}
            />
          </FormItem>
          <FormItem label='补充说明'>
            <Textarea
              value={form.pasted_text}
              onChange={(v) => setForm({ ...form, pasted_text: String(v) })}
              autosize={{ minRows: 3, maxRows: 6 }}
            />
          </FormItem>
        </Form>
      </Dialog>
    </div>
  );
};

const Metric: React.FC<{ title: string; value: number; color?: string }> = ({ title, value, color }) => (
  <Card bordered>
    <div style={{ color: 'var(--td-text-color-secondary)' }}>{title}</div>
    <div style={{ fontSize: 32, fontWeight: 700, color }}>{value}</div>
  </Card>
);

export default RecheckTasks;
