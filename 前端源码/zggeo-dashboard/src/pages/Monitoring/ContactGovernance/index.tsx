import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Input,
  MessagePlugin,
  PrimaryTableCol,
  Select,
  Space,
  Table,
  Tag,
  Textarea,
} from 'tdesign-react';
import { CheckCircleFilledIcon, CloseCircleFilledIcon, MobileIcon, RefreshIcon, SearchIcon } from 'tdesign-icons-react';
import {
  ContactAuditResult,
  ContactGovernanceProfile,
  ContactVisibilityResult,
  createContactAuditRun,
  createContactGovernanceProfile,
  createContactVisibilityRun,
  generateContactDeploymentPackage,
  listContactGovernanceProfiles,
} from 'services/zggeo-api';
import {
  buildProjectSourceOptions,
  defaultUrlsFor,
  loadProjectSources,
  normalizeDomain,
  parseList,
  ProjectContext,
} from 'utils/projectContext';
import styles from '../linear.module.less';

const DEFAULT_QUESTIONS = `公司电话是多少？
官方联系电话是多少？
如何联系这个品牌？
客服电话是多少？
商务咨询电话是多少？
相关服务应该拨打哪个电话？`;

const phoneFromText = (text: string) => {
  const matched = String(text || '').match(
    /(?:\+86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}|400[-\s]?\d{3}[-\s]?\d{4}|0\d{2,3}[-\s]?\d{7,8}/,
  );
  return matched?.[0]?.replace(/\s+/g, '') || '';
};

const leadIdFromSource = (sourceId: string) => (sourceId.startsWith('lead:') ? sourceId.slice(5) : undefined);

const metricText = (value: unknown, suffix = '') =>
  value === null || value === undefined || value === '' ? '-' : `${value}${suffix}`;

const summaryValue = (summary: Record<string, any> | undefined, key: string) => summary?.[key];

const ContactGovernance: React.FC = () => {
  const [sources, setSources] = useState<ProjectContext[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [profiles, setProfiles] = useState<ContactGovernanceProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [domain, setDomain] = useState('');
  const [officialPhone, setOfficialPhone] = useState('');
  const [invalidPhones, setInvalidPhones] = useState('');
  const [contactPageUrl, setContactPageUrl] = useState('');
  const [questions, setQuestions] = useState(DEFAULT_QUESTIONS);
  const [providers, setProviders] = useState('doubao');
  const [auditResults, setAuditResults] = useState<ContactAuditResult[]>([]);
  const [visibilityResults, setVisibilityResults] = useState<ContactVisibilityResult[]>([]);
  const [auditSummary, setAuditSummary] = useState<Record<string, any> | null>(null);
  const [visibilitySummary, setVisibilitySummary] = useState<Record<string, any> | null>(null);
  const [deploymentPackage, setDeploymentPackage] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState('');

  const sourceOptions = useMemo(() => buildProjectSourceOptions(sources), [sources]);
  const profileOptions = useMemo(
    () => profiles.map((item) => ({ label: `${item.project_name} · ${item.domain}`, value: item.id })),
    [profiles],
  );
  const activeProfile = useMemo(
    () => profiles.find((item) => item.id === activeProfileId) || null,
    [profiles, activeProfileId],
  );

  const loadAll = async () => {
    setLoading('init');
    try {
      const [nextSources, nextProfiles] = await Promise.all([loadProjectSources(), listContactGovernanceProfiles()]);
      setSources(nextSources);
      setProfiles(nextProfiles);
      if (!activeProfileId && nextProfiles[0]) setActiveProfileId(nextProfiles[0].id);
    } catch (err: any) {
      MessagePlugin.error(`数据读取失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setLoading('');
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applySource = (value: unknown, context?: any) => {
    const raw = String(
      (Array.isArray(value) ? value[0] : value) ||
        context?.selectedOptions?.[0]?.value ||
        context?.selectedOption?.value ||
        '',
    );
    const source = sources.find((item) => item.id === raw);
    if (!source) return;
    const cleanDomain = normalizeDomain(source.domain);
    setSourceId(source.id);
    setProjectName(source.project_name || cleanDomain);
    setCompanyName(source.project_name || '');
    setDomain(cleanDomain);
    setContactPageUrl(cleanDomain ? `https://${cleanDomain}/contact` : '');
    const guessedPhone = phoneFromText(source.notes || source.description || '');
    if (guessedPhone) setOfficialPhone(guessedPhone);
    const brand = source.project_name || '该品牌';
    setQuestions(
      [
        `${brand}电话是多少？`,
        `${brand}官方联系电话是多少？`,
        `如何联系${brand}？`,
        `${brand}客服电话是多少？`,
        `${brand}商务咨询电话是多少？`,
        `做${source.keywords[0] || brand}相关服务应该拨打哪个电话？`,
      ].join('\n'),
    );
    MessagePlugin.success('已带入客户资产');
  };

  const createProfile = async () => {
    if (!projectName.trim() || !domain.trim() || !officialPhone.trim()) {
      MessagePlugin.warning('请填写项目名、域名和官方展示电话');
      return;
    }
    setLoading('profile');
    try {
      const profile = await createContactGovernanceProfile({
        lead_id: leadIdFromSource(sourceId),
        project_name: projectName.trim(),
        brand_name: projectName.trim(),
        company_name: companyName.trim() || projectName.trim(),
        domain: normalizeDomain(domain),
        official_phone: officialPhone.trim(),
        invalid_phones: parseList(invalidPhones),
        preferred_display_phone: officialPhone.trim(),
        contact_page_url: contactPageUrl.trim() || undefined,
        verified_status: 'verified',
      });
      setProfiles((old) => [profile, ...old.filter((item) => item.id !== profile.id)]);
      setActiveProfileId(profile.id);
      MessagePlugin.success('电话治理档案已创建');
    } catch (err: any) {
      MessagePlugin.error(`创建失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setLoading('');
    }
  };

  const runAudit = async () => {
    if (!activeProfileId) {
      MessagePlugin.warning('请先选择电话治理档案');
      return;
    }
    setLoading('audit');
    try {
      const data = await createContactAuditRun({
        profile_id: activeProfileId,
        urls: activeProfile?.domain ? defaultUrlsFor(normalizeDomain(activeProfile.domain)).slice(0, 4) : [],
      });
      setAuditResults(data.results || []);
      setAuditSummary(data.summary || {});
      MessagePlugin.success('官网电话体检完成');
    } catch (err: any) {
      MessagePlugin.error(`体检失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setLoading('');
    }
  };

  const runVisibility = async () => {
    if (!activeProfileId) {
      MessagePlugin.warning('请先选择电话治理档案');
      return;
    }
    setLoading('visibility');
    try {
      const data = await createContactVisibilityRun({
        profile_id: activeProfileId,
        questions: questions
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        providers: parseList(providers),
      });
      setVisibilityResults(data.results || []);
      setVisibilitySummary(data.summary || {});
      MessagePlugin.success('豆包电话监测完成');
    } catch (err: any) {
      MessagePlugin.error(`监测失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setLoading('');
    }
  };

  const buildPackage = async () => {
    if (!activeProfileId) {
      MessagePlugin.warning('请先选择电话治理档案');
      return;
    }
    setLoading('package');
    try {
      const data = await generateContactDeploymentPackage({ profile_id: activeProfileId });
      setDeploymentPackage(data);
      MessagePlugin.success('联系方式修复包已生成');
    } catch (err: any) {
      MessagePlugin.error(`生成失败：${err?.response?.data?.detail || err?.message || '请稍后重试'}`);
    } finally {
      setLoading('');
    }
  };

  const copyPackage = async () => {
    if (!deploymentPackage) return;
    await navigator.clipboard.writeText(JSON.stringify(deploymentPackage, null, 2));
    MessagePlugin.success('修复包已复制');
  };

  const auditColumns: PrimaryTableCol<ContactAuditResult>[] = [
    { colKey: 'source_url', title: '来源页面', ellipsis: true, width: 240 },
    { colKey: 'extracted_phone', title: '提取号码', width: 140 },
    {
      colKey: 'is_official',
      title: '官方号码',
      width: 110,
      cell: ({ row }) =>
        row.is_official ? <Tag theme='success'>是</Tag> : <Tag theme={row.is_invalid ? 'danger' : 'warning'}>否</Tag>,
    },
    {
      colKey: 'has_tel_link',
      title: 'tel链接',
      width: 100,
      cell: ({ row }) =>
        row.has_tel_link ? <CheckCircleFilledIcon color='#059669' /> : <CloseCircleFilledIcon color='#dc2626' />,
    },
    {
      colKey: 'risk_level',
      title: '风险',
      width: 90,
      cell: ({ row }) => (
        <Tag theme={row.risk_level === 'high' ? 'danger' : row.risk_level === 'medium' ? 'warning' : 'success'}>
          {row.risk_level}
        </Tag>
      ),
    },
    { colKey: 'suggestion', title: '建议', ellipsis: true },
  ];

  const visibilityColumns: PrimaryTableCol<ContactVisibilityResult>[] = [
    { colKey: 'provider_name', title: '模型', width: 180, ellipsis: true },
    { colKey: 'question', title: '问题', width: 220, ellipsis: true },
    {
      colKey: 'detected_phones',
      title: '展示号码',
      width: 180,
      cell: ({ row }) => (row.detected_phones || []).join('、') || '-',
    },
    {
      colKey: 'correct_phone_shown',
      title: '正确',
      width: 90,
      cell: ({ row }) => (row.correct_phone_shown ? <Tag theme='success'>是</Tag> : <Tag theme='danger'>否</Tag>),
    },
    { colKey: 'score', title: '得分', width: 90 },
    { colKey: 'answer', title: '回答摘要', ellipsis: true },
  ];

  return (
    <div className={styles.page}>
      <div className={`${styles.heroCard} ${styles.toolbarRow}`} style={{ padding: 18 }}>
        <div>
          <div className={styles.statLabel}>CONTACT GOVERNANCE</div>
          <div className={styles.heroTitle}>联系方式治理</div>
          <div className={styles.heroDesc}>围绕官方电话做官网体检、豆包监测、Schema 与 llms 联系方式修复包。</div>
        </div>
        <Space>
          <Button icon={<RefreshIcon />} loading={loading === 'init'} onClick={loadAll}>
            刷新
          </Button>
          <Button theme='primary' icon={<MobileIcon />} loading={loading === 'profile'} onClick={createProfile}>
            保存档案
          </Button>
        </Space>
      </div>

      <div className={styles.gridAuto}>
        <Card title='电话治理档案' bordered={false}>
          <Space direction='vertical' style={{ width: '100%' }} size={14}>
            <Select
              clearable
              filterable
              value={sourceId}
              options={sourceOptions}
              placeholder='选择客户资产'
              onChange={applySource}
            />
            <Input value={projectName} placeholder='品牌 / 项目名' onChange={(v) => setProjectName(String(v))} />
            <Input value={companyName} placeholder='公司全称' onChange={(v) => setCompanyName(String(v))} />
            <Input value={domain} placeholder='官网域名' onChange={(v) => setDomain(String(v))} />
            <Input value={officialPhone} placeholder='官方展示电话' onChange={(v) => setOfficialPhone(String(v))} />
            <Textarea
              value={invalidPhones}
              autosize={{ minRows: 2, maxRows: 4 }}
              placeholder='无效号码黑名单，一行一个'
              onChange={(v) => setInvalidPhones(String(v))}
            />
            <Input value={contactPageUrl} placeholder='联系页 URL' onChange={(v) => setContactPageUrl(String(v))} />
            <Select
              value={activeProfileId}
              options={profileOptions}
              placeholder='选择已有档案'
              onChange={(v) => setActiveProfileId(String(v))}
            />
          </Space>
        </Card>

        <Card title='核心指标' bordered={false}>
          <div className={styles.statsGrid}>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>官网一致性</div>
              <div className={styles.statValue}>
                {metricText(
                  summaryValue(auditSummary || activeProfile?.latest_audit?.summary, 'consistency_score'),
                  '分',
                )}
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>豆包展示率</div>
              <div className={styles.statValue}>
                {metricText(
                  summaryValue(visibilitySummary || activeProfile?.latest_visibility?.summary, 'phone_display_rate'),
                  '%',
                )}
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>电话准确率</div>
              <div className={styles.statValue}>
                {metricText(
                  summaryValue(visibilitySummary || activeProfile?.latest_visibility?.summary, 'phone_accuracy_rate'),
                  '%',
                )}
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>错误号命中</div>
              <div className={styles.statValue}>
                {metricText(summaryValue(auditSummary || activeProfile?.latest_audit?.summary, 'invalid_phone_hits'))}
              </div>
            </div>
          </div>
          <Space style={{ marginTop: 18 }}>
            <Button theme='primary' icon={<SearchIcon />} loading={loading === 'audit'} onClick={runAudit}>
              官网体检
            </Button>
            <Button theme='primary' variant='outline' loading={loading === 'visibility'} onClick={runVisibility}>
              豆包监测
            </Button>
            <Button variant='outline' loading={loading === 'package'} onClick={buildPackage}>
              生成修复包
            </Button>
          </Space>
        </Card>
      </div>

      <Card title='豆包电话监测问题' bordered={false} style={{ marginTop: 16 }}>
        <Space direction='vertical' style={{ width: '100%' }}>
          <Input value={providers} placeholder='模型 provider，例如 doubao' onChange={(v) => setProviders(String(v))} />
          <Textarea value={questions} autosize={{ minRows: 5, maxRows: 8 }} onChange={(v) => setQuestions(String(v))} />
        </Space>
      </Card>

      <Card title='官网电话体检结果' bordered={false} style={{ marginTop: 16 }}>
        <Table rowKey='source_url' columns={auditColumns} data={auditResults} loading={loading === 'audit'} />
      </Card>

      <Card title='豆包电话监测结果' bordered={false} style={{ marginTop: 16 }}>
        <Table
          rowKey='question'
          columns={visibilityColumns}
          data={visibilityResults}
          loading={loading === 'visibility'}
        />
      </Card>

      {deploymentPackage && (
        <Card
          title='联系方式修复包'
          bordered={false}
          style={{ marginTop: 16 }}
          actions={<Button onClick={copyPackage}>复制</Button>}
        >
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 360, overflow: 'auto' }}>
            {JSON.stringify(deploymentPackage, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  );
};

export default ContactGovernance;
