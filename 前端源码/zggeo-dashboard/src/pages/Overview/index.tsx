import React, { useEffect, useMemo, useState } from 'react';
import { Button, Loading } from 'tdesign-react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AiEditIcon,
  AiSearchIcon,
  ArrowRightIcon,
  ChartIcon,
  CheckCircleFilledIcon,
  FileCopyIcon,
  InfoCircleFilledIcon,
  MoneyIcon,
  RefreshIcon,
  RocketIcon,
  SearchIcon,
  SendIcon,
  UsergroupIcon,
} from 'tdesign-icons-react';

import { listTasks, listLeads, AnalysisTaskRow, Lead } from 'services/zggeo-api';
import Style from './index.module.less';

const DELIVERY_STEPS = [
  { no: '01', title: '客户资产', desc: '品牌、官网、关键词、竞品资料统一沉淀', path: '/keyword-system/customer-assets-new' },
  { no: '02', title: 'AI 可见度诊断', desc: '运行官网检测、模型对比和问题库分析', path: '/visibility-monitoring/diagnosis' },
  { no: '03', title: 'GEO 资产增强', desc: '生成 llms.txt、Schema、基础资料与部署包', path: '/visibility-monitoring/geo-assets-new/base' },
  { no: '04', title: '内容与分发', desc: '把问题转成文章，并进入媒体市场发布闭环', path: '/content-generation/articles-new' },
];

const FEATURE_GROUPS = [
  {
    title: '客户资料',
    desc: '维护客户、品牌、官网、关键词和竞品资料',
    path: '/keyword-system/customer-assets-new',
    icon: <UsergroupIcon />,
    tone: 'cyan',
    tag: '客户入口',
  },
  {
    title: '监测任务',
    desc: '发起官网诊断，查看抓取、评分和运行状态',
    path: '/visibility-monitoring/diagnosis',
    icon: <SearchIcon />,
    tone: 'blue',
    tag: '先做这个',
  },
  {
    title: '评分报告',
    desc: '查看 AI 可见度分数、等级和改进建议',
    path: '/visibility-monitoring/geo-assets-new/report',
    icon: <FileCopyIcon />,
    tone: 'violet',
    tag: '交付报告',
  },
  {
    title: '关键词拓展',
    desc: '生成目标关键词，补齐非品牌词机会',
    path: '/keyword-system/keyword-expansion',
    icon: <AiSearchIcon />,
    tone: 'green',
    tag: '增长机会',
  },
  {
    title: 'Prompt 库',
    desc: '沉淀用户真实提问，用于模型可见度监测',
    path: '/keyword-system/prompt-inventory',
    icon: <ChartIcon />,
    tone: 'amber',
    tag: '问题资产',
  },
  {
    title: 'GEO 资产',
    desc: '生成 llms.txt、Schema、技术修复清单',
    path: '/visibility-monitoring/geo-assets-new/base',
    icon: <RocketIcon />,
    tone: 'teal',
    tag: '资产生成',
  },
  {
    title: '文章生成',
    desc: '把高价值问题转成可发布内容草稿',
    path: '/content-generation/articles-new',
    icon: <AiEditIcon />,
    tone: 'rose',
    tag: '内容生产',
  },
  {
    title: '分发执行',
    desc: '进入发布任务台、媒体市场和发稿记录',
    path: '/distribution/market',
    icon: <SendIcon />,
    tone: 'orange',
    tag: '内容分发',
  },
  {
    title: '账单点数',
    desc: '查看套餐权益、点数账户和消耗明细',
    path: '/billing/credits',
    icon: <MoneyIcon />,
    tone: 'slate',
    tag: '账户中心',
  },
];

const Overview: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<AnalysisTaskRow[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [taskRows, leadRows] = await Promise.all([listTasks({ latest_only: true }), listLeads()]);
      setTasks(taskRows);
      setLeads(leadRows);
    } catch {
      // ignore and keep fallback values on page
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const metrics = useMemo(() => {
    const completedTasks = tasks.filter((task) => task.status === 'completed');
    const runningTasks = tasks.filter((task) => task.status === 'running' || task.status === 'pending');
    const scores = completedTasks
      .map((task) => task.total_score)
      .filter((score): score is number => typeof score === 'number');

    const avgScore =
      scores.length > 0 ? Math.round(scores.reduce((sum, current) => sum + current, 0) / scores.length) : 0;

    const domainSet = new Set(tasks.map((task) => task.domain).filter(Boolean));
    const projectCount = domainSet.size;

    const passRate =
      completedTasks.length > 0
        ? Math.round(
            (completedTasks.filter((task) => (task.total_score || 0) >= 60).length / completedTasks.length) * 100,
          )
        : 0;

    const excellentRate =
      completedTasks.length > 0
        ? Math.round(
            (completedTasks.filter((task) => (task.total_score || 0) >= 80).length / completedTasks.length) * 100,
          )
        : 0;

    const newLeads = leads.filter((lead) => lead.followup_status === 'new').length;
    const pendingLeads = leads.filter(
      (lead) => lead.followup_status !== 'closed' && lead.followup_status !== undefined,
    ).length;

    return {
      avgScore,
      projectCount,
      passRate,
      excellentRate,
      completedCount: completedTasks.length,
      runningCount: runningTasks.length,
      totalLeads: leads.length,
      newLeads,
      pendingLeads,
      topTask: completedTasks.sort((a, b) => (b.total_score || 0) - (a.total_score || 0))[0],
      latestReport: completedTasks.find((task) => task.is_latest_report && task.report_id),
    };
  }, [leads, tasks]);

  const recentActivities = useMemo(() => {
    const items: { icon: React.ReactNode; text: string; sub: string; onClick?: () => void }[] = [];

    if (metrics.topTask) {
      items.push({
        icon: <CheckCircleFilledIcon />,
        text: `${metrics.topTask.project_name} 取得 ${metrics.topTask.total_score} 分 (${metrics.topTask.grade})`,
        sub: new Date(metrics.topTask.created_at).toLocaleString('zh-CN'),
        onClick: () =>
          metrics.topTask?.report_id &&
          navigate(`/visibility-monitoring/geo-assets-new/report?report_id=${metrics.topTask.report_id}`),
      });
    }

    if (metrics.newLeads > 0) {
      items.push({
        icon: <InfoCircleFilledIcon />,
        text: `${metrics.newLeads} 条新留资待跟进`,
        sub: '去客户资产继续推进',
        onClick: () => navigate('/keyword-system/customer-assets-new'),
      });
    }

    if (metrics.runningCount > 0) {
      items.push({
        icon: <InfoCircleFilledIcon />,
        text: `${metrics.runningCount} 个任务分析中`,
        sub: '队列仍在持续推进',
        onClick: () => navigate('/visibility-monitoring/diagnosis'),
      });
    }

    tasks
      .filter((task) => task.status === 'completed')
      .slice(0, 3)
      .forEach((task) => {
        items.push({
          icon: <CheckCircleFilledIcon />,
          text: `${task.project_name} 分析完成 · ${task.total_score ?? '-'} 分`,
          sub: new Date(task.created_at).toLocaleString('zh-CN'),
          onClick: () =>
            task.report_id && navigate(`/visibility-monitoring/geo-assets-new/report?report_id=${task.report_id}`),
        });
      });

    return items.slice(0, 6);
  }, [metrics, navigate, tasks]);

  const firstLoading = loading && tasks.length === 0 && leads.length === 0;

  if (firstLoading) {
    return (
      <div className={Style.page}>
        <div className={Style.loadingPanel}>
          <Loading size='medium' />
          <div className={Style.loadingText}>正在生成首页…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={Style.page}>
      <section className={Style.heroPanel}>
        <div className={Style.heroBackdrop} aria-hidden='true'>
          <div className={Style.heroGridGlow}></div>
          <div className={Style.heroScanLine}></div>
          <div className={Style.heroOrbit}>
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
        <div className={Style.heroTop}>
          <div className={Style.heroBadge}>ZGEO WORKSPACE</div>
          <div className={Style.heroTopRight}>
            <div className={Style.heroHint}>最新运行时状态已接入真实数据</div>
            <Button
              theme='default'
              variant='outline'
              icon={<RefreshIcon />}
              loading={loading}
              onClick={fetchAll}
              className={Style.ghostButton}
            >
              刷新数据
            </Button>
          </div>
        </div>

        <div className={Style.heroGrid}>
          <div className={Style.heroCopy}>
            <div className={Style.heroTitle}>让企业在 AI 搜索时代被看见、被推荐、被选择。</div>
            <div className={Style.heroDesc}>
              从客户资产沉淀、AI 可见度诊断、GEO 资产生成，到内容生产与分发执行，统一在首页完成入口调度。
            </div>
            <div className={Style.heroSub}>面向客户交付的 AI 搜索增长工作台，把高频动作前置，让客户进入系统后能马上找到下一步。</div>

            <div className={Style.heroLeftDashboard}>
              <div className={Style.heroMetricGrid}>
                <MetricCard
                  label='平均评分'
                  value={metrics.avgScore}
                  unit='分'
                  sub={`${metrics.completedCount} 份已完成报告`}
                  onClick={() => navigate('/visibility-monitoring/diagnosis')}
                />
                <MetricCard
                  label='已监测项目'
                  value={metrics.projectCount}
                  unit='个'
                  sub={`${metrics.runningCount} 个进行中`}
                  onClick={() => navigate('/visibility-monitoring/diagnosis')}
                />
                <MetricCard
                  label='达标率'
                  value={metrics.passRate}
                  unit='%'
                  sub={`优秀占比 ${metrics.excellentRate}%`}
                  onClick={() => navigate('/visibility-monitoring/diagnosis')}
                />
                <MetricCard
                  label='待跟进留资'
                  value={metrics.pendingLeads}
                  sub={`新留资 ${metrics.newLeads} · 总留资 ${metrics.totalLeads}`}
                  onClick={() => navigate('/keyword-system/customer-assets-new')}
                />
              </div>

              <div className={Style.heroCompactPanels}>
                <section className={Style.heroFlowPanel}>
                  <div className={Style.heroPanelLabel}>DELIVERY FLOW</div>
                  <div className={Style.heroPanelTitle}>客户交付链路</div>
                  <div className={Style.flowTrack}>
                    {DELIVERY_STEPS.map((step) => (
                      <button key={step.no} type='button' className={Style.flowStep} onClick={() => navigate(step.path)}>
                        <span className={Style.flowNo}>{step.no}</span>
                        <span className={Style.flowBody}>
                          <strong>{step.title}</strong>
                          <em>{step.desc}</em>
                        </span>
                        <ArrowRightIcon />
                      </button>
                    ))}
                  </div>
                </section>

                <section className={Style.heroSignalsPanel}>
                  <div className={Style.heroPanelLabel}>RECENT SIGNALS</div>
                  <div className={Style.heroPanelTitle}>最近动态</div>
                  <div className={Style.activityList}>
                    {recentActivities.length === 0 ? (
                      <div className={Style.heroEmptySignal}>还没有最新动态，先完成第一条诊断链路。</div>
                    ) : (
                      recentActivities.slice(0, 3).map((item, index) => (
                        <button
                          key={`${item.text}-${index}`}
                          type='button'
                          className={Style.activityItem}
                          onClick={item.onClick}
                        >
                          <div className={Style.activityIcon}>{item.icon}</div>
                          <div className={Style.activityContent}>
                            <div className={Style.activityText}>{item.text}</div>
                            <div className={Style.activitySub}>{item.sub}</div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </section>
              </div>
            </div>
          </div>

          <div className={Style.quickActions}>
            <div className={Style.quickActionHead}>
              <div>
                <div className={Style.quickActionEyebrow}>核心功能入口</div>
                <div className={Style.quickActionTitle}>AI 搜索增长控制台</div>
              </div>
              <div className={Style.quickActionButtons}>
                <Button
                  theme='primary'
                  onClick={() => navigate('/visibility-monitoring/diagnosis')}
                  className={Style.primaryButton}
                >
                  去监测任务
                </Button>
                <Button
                  theme='default'
                  variant='outline'
                  onClick={() =>
                    navigate(
                      metrics.latestReport?.report_id
                        ? `/visibility-monitoring/geo-assets-new/report?report_id=${metrics.latestReport.report_id}`
                        : '/visibility-monitoring/geo-assets-new/report',
                    )
                  }
                  disabled={!metrics.latestReport}
                  className={Style.ghostButton}
                >
                  最新报告
                </Button>
              </div>
            </div>
            <div className={Style.heroShortcutGrid}>
              {FEATURE_GROUPS.map((feature) => (
                <Link
                  key={feature.path}
                  to={feature.path}
                  className={`${Style.heroShortcutCard} ${Style[`featureTone${feature.tone}`]}`}
                >
                  <span className={Style.heroShortcutIcon}>{feature.icon}</span>
                  <span className={Style.heroShortcutText}>
                    <strong>{feature.title}</strong>
                    <em>{feature.tag}</em>
                    <small>{feature.desc}</small>
                  </span>
                  <ArrowRightIcon className={Style.heroShortcutArrow} />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

interface MetricCardProps {
  label: string;
  value: number;
  unit?: string;
  sub: string;
  onClick?: () => void;
}

const MetricCard: React.FC<MetricCardProps> = ({ label, value, unit, sub, onClick }) => (
  <button type='button' className={Style.metricCard} onClick={onClick}>
    <div className={Style.metricLabel}>{label}</div>
    <div className={Style.metricValueRow}>
      <span className={Style.metricValue}>{value}</span>
      {unit ? <span className={Style.metricUnit}>{unit}</span> : null}
    </div>
    <div className={Style.metricSub}>{sub}</div>
  </button>
);

export default Overview;
