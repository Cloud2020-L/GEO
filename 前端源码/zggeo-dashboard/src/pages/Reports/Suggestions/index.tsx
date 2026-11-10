import React, { useEffect, useMemo, useState } from 'react';
import { Card, Tag, Button, Space, Input, Skeleton, MessagePlugin, Select } from 'tdesign-react';
import {
  RefreshIcon,
  SearchIcon,
  ThunderIcon as FireIcon,
  LightbulbIcon,
  ErrorCircleFilledIcon,
  InfoCircleFilledIcon,
} from 'tdesign-icons-react';
import { useNavigate } from 'react-router-dom';
import { listTasks, getReportsBatch, AnalysisTaskRow, ReportResponse } from 'services/zggeo-api';
import Style from '../linear.module.less';

/**
 * L4 产品化报告 · 改进建议汇总
 *
 * 从所有最新报告里抓 top_issues / top_fixes，做词频聚合
 * 找出：
 *   - Top 10 高频问题（跨多少个项目出现）
 *   - Top 10 高频建议（会影响到哪些项目）
 */

const GRADE_COLOR: Record<string, string> = {
  S: '#10B981',
  A: '#10B981',
  B: '#3B82F6',
  C: '#F59E0B',
  D: '#EF4444',
  E: '#EF4444',
};

interface Bucket {
  text: string;
  count: number;
  domains: { project_name: string; domain: string; grade: string; report_id: string }[];
}

// 聚合函数：把 reports 里的某个字段 (top_issues / top_fixes) 全部展开 → 词频
const aggregate = (reports: ReportResponse[], field: 'top_issues' | 'top_fixes'): Bucket[] => {
  const map: Record<string, Bucket> = {};
  reports.forEach((r) => {
    const arr = (r[field] || []) as string[];
    arr.forEach((raw) => {
      // 去掉两端空格 + 句末标点，避免「缺乏案例。」跟「缺乏案例」算两条
      const key = raw
        .trim()
        .replace(/[。.!?；;,，\s]+$/g, '')
        .trim();
      if (!key) return;
      if (!map[key]) {
        map[key] = { text: key, count: 0, domains: [] };
      }
      map[key].count += 1;
      map[key].domains.push({
        project_name: r.project_name,
        domain: r.domain,
        grade: r.grade,
        report_id: r.report_id,
      });
    });
  });
  return Object.values(map).sort((a, b) => b.count - a.count);
};

const Suggestions: React.FC = () => {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<AnalysisTaskRow[]>([]);
  const [reports, setReports] = useState<ReportResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'issues' | 'fixes'>('issues');

  const fetchData = async () => {
    setLoading(true);
    try {
      const t = await listTasks({ latest_only: true });
      setTasks(t);
      const reportIds = t.filter((x) => x.status === 'completed' && x.report_id).map((x) => x.report_id as string);
      if (reportIds.length > 0) {
        const rs = await getReportsBatch(reportIds);
        setReports(rs);
      } else {
        setReports([]);
      }
    } catch (e) {
      MessagePlugin.error('拉取建议汇总失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const issues = useMemo(() => aggregate(reports, 'top_issues'), [reports]);
  const fixes = useMemo(() => aggregate(reports, 'top_fixes'), [reports]);
  const currentBuckets = mode === 'issues' ? issues : fixes;

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return currentBuckets;
    return currentBuckets.filter((b) => b.text.toLowerCase().includes(kw));
  }, [currentBuckets, keyword]);

  const summary = useMemo(() => {
    return {
      totalReports: reports.length,
      uniqueIssues: issues.length,
      uniqueFixes: fixes.length,
      mostCommonIssue: issues[0]?.text || '—',
      mostCommonFix: fixes[0]?.text || '—',
    };
  }, [reports, issues, fixes]);

  const maxCount = filtered[0]?.count || 1;

  return (
    <div className={Style.page}>
      <Card bordered={false} className={Style.heroCard} bodyStyle={{ padding: 24 }}>
        <Space size={8} style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <Tag theme='primary' variant='light'>
            产品化报告
          </Tag>
          <Tag theme='warning' variant='light'>
            改进建议
          </Tag>
        </Space>
        <div className={Style.heroTitle}>改进建议</div>
        <div className={Style.heroDesc}>
          跨所有最新评分报告汇总高频问题与高频修复建议，找出最值得我们优先处理的共性缺口。
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <Card bordered={false} className={Style.noticeCard}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: 'linear-gradient(135deg, #ef4444, #f97316)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 24,
              }}
            >
              <ErrorCircleFilledIcon />
            </div>
            <div style={{ flex: 1 }}>
              <div className={Style.statLabel}>最高频问题</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#fca5a5', marginTop: 2 }}>
                {summary.mostCommonIssue}
              </div>
              <div className={Style.mutedText} style={{ fontSize: 11, marginTop: 2 }}>
                共 {summary.uniqueIssues} 类问题，覆盖 {reports.length} 份报告
              </div>
            </div>
          </div>
        </Card>

        <Card bordered={false} className={Style.noticeCard}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: 'linear-gradient(135deg, #10b981, #14b8a6)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 24,
              }}
            >
              <LightbulbIcon />
            </div>
            <div style={{ flex: 1 }}>
              <div className={Style.statLabel}>最推荐改进</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#6ee7b7', marginTop: 2 }}>
                {summary.mostCommonFix}
              </div>
              <div className={Style.mutedText} style={{ fontSize: 11, marginTop: 2 }}>
                共 {summary.uniqueFixes} 条建议，涵盖所有项目
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* 操作栏 */}
      <Card bordered={false} className={Style.sectionCard} style={{ marginBottom: 16 }}>
        <div className={Style.toolbarRow}>
          <Select
            value={mode}
            options={[
              { label: '高频问题 Top', value: 'issues' },
              { label: '高频建议 Top', value: 'fixes' },
            ]}
            onChange={(v) => setMode(v as 'issues' | 'fixes')}
            style={{ width: 160 }}
          />
          <Input
            prefixIcon={<SearchIcon />}
            placeholder='搜关键词'
            value={keyword}
            onChange={(v) => setKeyword(v as string)}
            style={{ width: 240 }}
          />
          <div style={{ flex: 1 }} />
          <Tag theme='success' variant='light'>
            {filtered.length} 条聚合结果 / 参考 {reports.length} 份报告
          </Tag>
          <Button icon={<RefreshIcon />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
        </div>
      </Card>

      {/* 列表 */}
      {loading && reports.length === 0 ? (
        <div style={{ display: 'grid', gap: 10 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Card key={i} bordered={false} className={Style.itemCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <Skeleton animation='gradient' loading rowCol={[{ width: '40px', height: '40px' }]} />
                <div style={{ flex: 1 }}>
                  <Skeleton
                    animation='gradient'
                    theme='paragraph'
                    loading
                    rowCol={[
                      { width: '80%', height: '16px' },
                      { width: '50%', height: '14px' },
                    ]}
                  />
                </div>
                <Skeleton animation='gradient' loading rowCol={[{ width: '72px', height: '24px' }]} />
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {filtered.length === 0 && (
            <Card bordered={false} className={Style.sectionCard} style={{ padding: 48, textAlign: 'center' }}>
              <div className={Style.mutedText}>{keyword ? '没有命中关键词的条目' : '暂无数据'}</div>
            </Card>
          )}
          {filtered.slice(0, 50).map((b, idx) => {
            const pct = (b.count / maxCount) * 100;
            return (
              <Card
                key={b.text}
                bordered={false}
                className={Style.itemCard}
                style={{ position: 'relative', overflow: 'hidden' }}
                hoverShadow
              >
                {/* 背景进度条 */}
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${pct}%`,
                    background:
                      mode === 'issues'
                        ? 'linear-gradient(90deg, rgba(239,68,68,0.08) 0%, rgba(239,68,68,0.02) 100%)'
                        : 'linear-gradient(90deg, rgba(16,185,129,0.08) 0%, rgba(16,185,129,0.02) 100%)',
                    pointerEvents: 'none',
                  }}
                />

                <div
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'start',
                    gap: 16,
                    flexWrap: 'wrap',
                  }}
                >
                  {/* 排名徽章 */}
                  <div
                    style={{
                      minWidth: 36,
                      height: 36,
                      borderRadius: 10,
                      background: idx < 3 ? (mode === 'issues' ? '#EF4444' : '#10B981') : '#F3F4F6',
                      color: idx < 3 ? '#fff' : 'rgba(226,232,240,0.72)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: 15,
                    }}
                  >
                    {idx < 3 ? <FireIcon /> : idx + 1}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.6, color: 'var(--td-text-color-primary)' }}
                    >
                      {b.text}
                    </div>
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {b.domains.slice(0, 6).map((d, i) => (
                        <Tag
                          key={i}
                          size='small'
                          variant='light'
                          style={{ cursor: 'pointer' }}
                          onClick={() => navigate(`/reports/scoring?report_id=${d.report_id}`)}
                        >
                          <span style={{ color: GRADE_COLOR[d.grade], fontWeight: 700, marginRight: 4 }}>
                            {d.grade}
                          </span>
                          {d.project_name}
                        </Tag>
                      ))}
                      {b.domains.length > 6 && (
                        <Tag size='small' variant='outline'>
                          +{b.domains.length - 6}
                        </Tag>
                      )}
                    </div>
                  </div>

                  {/* 命中次数 */}
                  <div style={{ textAlign: 'right', minWidth: 80 }}>
                    <div
                      style={{
                        fontSize: 22,
                        fontWeight: 700,
                        color: mode === 'issues' ? '#EF4444' : '#10B981',
                      }}
                    >
                      {b.count}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--td-text-color-placeholder)' }}>次命中</div>
                  </div>
                </div>
              </Card>
            );
          })}

          {filtered.length > 50 && (
            <Card bordered={false} className={Style.sectionCard} style={{ textAlign: 'center', padding: 16 }}>
              <InfoCircleFilledIcon style={{ color: 'rgba(226,232,240,0.72)' }} />
              <span style={{ marginLeft: 8, color: 'rgba(226,232,240,0.72)', fontSize: 13 }}>
                还有 {filtered.length - 50} 条，可用搜索框过滤
              </span>
            </Card>
          )}
        </div>
      )}
    </div>
  );
};

export default Suggestions;
