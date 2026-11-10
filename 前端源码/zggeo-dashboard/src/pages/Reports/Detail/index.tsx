import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { Card, Tag, Button, Space, Loading, MessagePlugin, Progress, Row, Col, Divider } from 'tdesign-react';
import {
  ArrowLeftIcon,
  RefreshIcon,
  FileCopyIcon,
  ErrorCircleFilledIcon,
  CheckCircleFilledIcon,
  LinkIcon,
} from 'tdesign-icons-react';
import {
  analyzeGeoSitemap,
  auditTechnicalGeoSeo,
  generateDeploymentPackage,
  getReport,
  ReportResponse,
  listTasks,
  AnalysisTaskRow,
} from 'services/zggeo-api';
import { useAppSelector } from 'modules/store';
import ScoreRadar from './ScoreRadar';
import Style from '../linear.module.less';

/**
 * L4 报告详情
 * URL 两种进入方式：
 * 1. /reports/scoring?report_id=<uuid>   直达某份报告
 * 2. /reports/scoring                    默认显示最新一份已完成任务的报告
 */

const GRADE_COLOR: Record<string, string> = {
  S: '#10B981',
  A: '#10B981',
  B: '#3B82F6',
  C: '#F59E0B',
  D: '#EF4444',
  E: '#EF4444',
};

const ReportDetail: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAppSelector((state) => state.user.userInfo) as Record<string, any>;
  const role = String(user?.role || '').toLowerCase();
  const reportIdFromUrl = searchParams.get('report_id');
  const isInternalScoringPage = location.pathname.startsWith('/reports/scoring');
  const canViewInternalScoring = ['admin', 'operator'].includes(role);
  const diagnosisListPath = '/visibility-monitoring/diagnosis';

  const [loading, setLoading] = useState(true);
  const [moduleLoading, setModuleLoading] = useState(false);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [recentTasks, setRecentTasks] = useState<AnalysisTaskRow[]>([]);
  const [technicalAudit, setTechnicalAudit] = useState<Record<string, any> | null>(null);
  const [sitemapAudit, setSitemapAudit] = useState<Record<string, any> | null>(null);
  const [deploymentPackage, setDeploymentPackage] = useState<Record<string, any> | null>(null);

  const fetchReport = async (reportId: string) => {
    setLoading(true);
    try {
      const data = await getReport(reportId);
      setReport(data);
      setModuleLoading(true);
      Promise.allSettled([
        auditTechnicalGeoSeo({ domain: data.domain }),
        analyzeGeoSitemap({ domain: data.domain, max_pages: 10 }),
        generateDeploymentPackage({
          project_name: data.project_name,
          domain: data.domain,
          description: data.summary_text,
          keywords: data.keywords,
          urls: data.urls,
          max_pages: 8,
          report_id: String(data.report_id),
        }),
      ]).then((results) => {
        if (results[0].status === 'fulfilled') setTechnicalAudit(results[0].value);
        if (results[1].status === 'fulfilled') setSitemapAudit(results[1].value);
        if (results[2].status === 'fulfilled') setDeploymentPackage(results[2].value);
        setModuleLoading(false);
      });
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      MessagePlugin.error(`拉取报告失败：${typeof detail === 'string' ? detail : err?.message || '未知错误'}`);
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  // 初始化：有 report_id 直接拉，没有就拉最新任务列表取第一个
  useEffect(() => {
    if (isInternalScoringPage && !canViewInternalScoring) {
      setLoading(false);
      return;
    }
    (async () => {
      // 先拉一次任务列表用于侧边栏
      try {
        const tasks = await listTasks({ latest_only: true });
        setRecentTasks(tasks.filter((t) => t.report_id).slice(0, 10));

        if (reportIdFromUrl) {
          await fetchReport(reportIdFromUrl);
        } else {
          // 找一份已完成的
          const first = tasks.find((t) => t.report_id);
          if (first?.report_id) {
            await fetchReport(first.report_id);
          } else {
            setLoading(false);
          }
        }
      } catch (err: any) {
        MessagePlugin.error(`初始化失败：${err?.message || '未知错误'}`);
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportIdFromUrl]);

  if (isInternalScoringPage && !canViewInternalScoring) {
    return (
      <div className={Style.page}>
        <Card className={Style.sectionCard} style={{ margin: 0 }} bordered={false}>
          <div style={{ textAlign: 'center', padding: 40 }}>
            <ErrorCircleFilledIcon style={{ fontSize: 40, color: '#999' }} />
            <div style={{ marginTop: 16, fontSize: 14, color: '#999' }}>当前账号无权访问内部报告分析。</div>
            <Button
              theme='primary'
              variant='outline'
              style={{ marginTop: 16 }}
              onClick={() => navigate(diagnosisListPath)}
            >
              返回基础诊断
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={Style.page} style={{ paddingTop: 60, textAlign: 'center' }}>
        <Loading size='large' text='拉取报告中...' />
      </div>
    );
  }

  if (!report) {
    return (
      <div className={Style.page}>
        <Card className={Style.sectionCard} style={{ margin: 0 }} bordered={false}>
          <div style={{ textAlign: 'center', padding: 40 }}>
            <ErrorCircleFilledIcon style={{ fontSize: 40, color: '#999' }} />
            <div style={{ marginTop: 16, fontSize: 14, color: '#999' }}>
              未找到可用诊断报告。请先到【基础诊断】完成诊断，或刷新报告列表后重试。
            </div>
            <Button
              theme='primary'
              variant='outline'
              style={{ marginTop: 16 }}
              onClick={() => navigate(diagnosisListPath)}
            >
              返回基础诊断
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const gradeColor = GRADE_COLOR[report.grade] || '#6366F1';
  const geoEnhancement = report.report_json?.geo_enhancement;
  const contactGovernance = (report.report_json as Record<string, any>)?.contact_governance;
  const contactRiskTheme =
    contactGovernance?.risk_level === 'high'
      ? 'danger'
      : contactGovernance?.risk_level === 'medium'
      ? 'warning'
      : 'success';

  return (
    <div className={Style.page}>
      {/* 顶部：返回 + 摘要 + 总分 */}
      <Card bordered={false} className={Style.heroCard} bodyStyle={{ padding: 24 }}>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
          <Space>
            <Button variant='text' icon={<ArrowLeftIcon />} onClick={() => navigate(diagnosisListPath)}>
              返回基础诊断
            </Button>
            <Divider layout='vertical' />
            <Tag theme='primary' variant='light'>
              {report.report_version || 'v2.0'}
            </Tag>
            {report.is_latest_report && (
              <Tag theme='success' variant='light'>
                最新
              </Tag>
            )}
            {report.is_productized_report && (
              <Tag theme='primary' variant='light'>
                产品化
              </Tag>
            )}
          </Space>
          <Space>
            <Button variant='outline' icon={<RefreshIcon />} onClick={() => fetchReport(report.report_id)}>
              刷新
            </Button>
            <Button
              variant='outline'
              icon={<FileCopyIcon />}
              onClick={() => {
                navigator.clipboard.writeText(report.report_id);
                MessagePlugin.success('已复制报告 ID');
              }}
            >
              复制报告 ID
            </Button>
          </Space>
        </Space>

        <Row gutter={24} align='middle'>
          <Col flex='auto'>
            <div className={Style.statLabel} style={{ marginBottom: 4 }}>
              {report.domain} · 生成于 {new Date(report.created_at).toLocaleString('zh-CN')}
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 600, margin: '4px 0 12px' }}>{report.project_name}</h1>
            <div className={Style.heroDesc} style={{ fontSize: 13, lineHeight: 1.8 }}>
              {report.summary_text}
            </div>
            <Space style={{ marginTop: 12, flexWrap: 'wrap' }} size={6}>
              {report.keywords.map((k) => (
                <Tag key={k} theme='primary' variant='outline' size='small'>
                  # {k}
                </Tag>
              ))}
            </Space>
          </Col>
          <Col flex='none'>
            <div
              style={{
                textAlign: 'center',
                padding: '16px 32px',
                background: `linear-gradient(135deg, ${gradeColor}15, ${gradeColor}05)`,
                border: `1px solid ${gradeColor}40`,
                borderRadius: 12,
                minWidth: 180,
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginBottom: 4 }}>综合评分</div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center' }}>
                <span style={{ fontSize: 48, fontWeight: 700, color: gradeColor, lineHeight: 1 }}>
                  {report.total_score}
                </span>
                <span style={{ fontSize: 18, color: gradeColor, marginLeft: 4 }}>分</span>
              </div>
              <div style={{ marginTop: 8 }}>
                <span
                  style={{
                    display: 'inline-block',
                    padding: '4px 16px',
                    background: gradeColor,
                    color: '#fff',
                    borderRadius: 20,
                    fontSize: 14,
                    fontWeight: 600,
                  }}
                >
                  等级 {report.grade}
                </span>
              </div>
            </div>
          </Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]}>
        {/* 左：雷达图 + 4 维分解 */}
        <Col xs={12} lg={7}>
          <Card bordered={false} className={Style.sectionCard} title='4 维评分' bodyStyle={{ padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <ScoreRadar
                visibility={report.visibility_score}
                structure={report.structure_score}
                trust={report.trust_score}
                content={report.content_coverage_score}
              />
            </div>

            <Divider />

            <ScoreLine
              label='可见度'
              value={report.visibility_score}
              reason={report.report_json?.score_reason_visibility}
            />
            <ScoreLine
              label='结构'
              value={report.structure_score}
              reason={report.report_json?.score_reason_structure}
            />
            <ScoreLine label='信任' value={report.trust_score} reason={report.report_json?.score_reason_trust} />
            <ScoreLine
              label='内容覆盖'
              value={report.content_coverage_score}
              reason={report.report_json?.score_reason_content}
            />
          </Card>
        </Col>

        {/* 中：问题 + 修复建议 */}
        <Col xs={12} lg={5}>
          <Card
            bordered={false}
            className={Style.sectionCard}
            title={
              <Space>
                <ErrorCircleFilledIcon style={{ color: '#EF4444' }} />
                <span>核心问题</span>
                <Tag size='small' theme='danger' variant='light'>
                  {report.top_issues.length}
                </Tag>
              </Space>
            }
            bodyStyle={{ padding: 20 }}
            style={{ marginBottom: 16 }}
          >
            {report.top_issues.length === 0 ? (
              <div style={{ color: '#999', fontSize: 13, padding: 12 }}>（无）</div>
            ) : (
              <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, fontSize: 13 }}>
                {report.top_issues.map((issue, i) => (
                  <li key={i} style={{ marginBottom: 8, color: 'var(--td-text-color-primary)' }}>
                    {issue}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card
            bordered={false}
            className={Style.sectionCard}
            title={
              <Space>
                <CheckCircleFilledIcon style={{ color: '#10B981' }} />
                <span>建议修复动作</span>
                <Tag size='small' theme='success' variant='light'>
                  {report.top_fixes.length}
                </Tag>
              </Space>
            }
            bodyStyle={{ padding: 20 }}
          >
            {report.top_fixes.length === 0 ? (
              <div style={{ color: '#999', fontSize: 13, padding: 12 }}>（无）</div>
            ) : (
              <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, fontSize: 13 }}>
                {report.top_fixes.map((fix, i) => (
                  <li key={i} style={{ marginBottom: 8, color: 'var(--td-text-color-primary)' }}>
                    {fix}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </Col>

        {/* 右：证据 + 近期报告导航 */}
        <Col xs={12} lg={4}>
          <Card
            bordered={false}
            className={Style.sectionCard}
            title={
              <Space>
                <span>证据片段</span>
                <Tag size='small' theme='default' variant='light'>
                  {report.evidence_snippets.length}
                </Tag>
              </Space>
            }
            bodyStyle={{ padding: 20, maxHeight: 300, overflowY: 'auto' }}
            style={{ marginBottom: 16 }}
          >
            {report.evidence_snippets.length === 0 ? (
              <div style={{ color: '#999', fontSize: 13 }}>（无）</div>
            ) : (
              report.evidence_snippets.map((ev, i) => (
                <div
                  key={i}
                  style={{
                    padding: 10,
                    marginBottom: 8,
                    background: 'var(--td-bg-color-container-hover)',
                    borderLeft: '3px solid #6366F1',
                    borderRadius: 4,
                    fontSize: 12,
                    lineHeight: 1.7,
                    color: 'var(--td-text-color-secondary)',
                  }}
                >
                  {ev}
                </div>
              ))
            )}
          </Card>

          <Card
            bordered={false}
            className={Style.sectionCard}
            title='近期报告'
            bodyStyle={{ padding: 12, maxHeight: 320, overflowY: 'auto' }}
          >
            {recentTasks.length === 0 ? (
              <div style={{ color: '#999', fontSize: 13, padding: 12 }}>（无）</div>
            ) : (
              recentTasks.map((t) => {
                const isCurrent = t.report_id === report.report_id;
                const color = GRADE_COLOR[t.grade || ''] || '#94A3B8';
                return (
                  <div
                    key={t.id}
                    onClick={() => t.report_id && navigate(`/reports/scoring?report_id=${t.report_id}`)}
                    style={{
                      padding: 10,
                      borderRadius: 6,
                      marginBottom: 4,
                      cursor: 'pointer',
                      background: isCurrent ? 'rgba(99,102,241,0.08)' : 'transparent',
                      borderLeft: isCurrent ? '3px solid #6366F1' : '3px solid transparent',
                      transition: 'all .2s',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{t.project_name}</span>
                      {typeof t.total_score === 'number' && (
                        <span
                          style={{
                            fontSize: 14,
                            fontWeight: 700,
                            color,
                          }}
                        >
                          {t.total_score}
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--td-text-color-placeholder)',
                        marginTop: 2,
                      }}
                    >
                      {t.domain}
                    </div>
                  </div>
                );
              })
            )}
          </Card>
        </Col>
      </Row>

      <Card
        bordered={false}
        className={Style.sectionCard}
        title={
          <Space>
            <LinkIcon style={{ color: '#0F766E' }} />
            <span>GEO 增强诊断</span>
            <Tag size='small' theme='success' variant='light'>
              AI 可引用性 / llms.txt / Schema
            </Tag>
          </Space>
        }
        bodyStyle={{ padding: 20 }}
        style={{ marginTop: 16 }}
      >
        {!geoEnhancement ? (
          <div style={{ color: 'var(--td-text-color-secondary)', fontSize: 13, lineHeight: 1.8 }}>
            这份报告生成于 GEO 增强模块上线之前，暂无增强诊断。新建或重新运行监测任务后，会自动生成 AI
            可引用性、答案块、实体信任、Schema 与 crawler 准备度评分。
          </div>
        ) : (
          <>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={6} lg={2}>
                <GeoMetric label='综合 GEO' value={geoEnhancement.overall_score} color='#0F766E' />
              </Col>
              <Col xs={12} sm={6} lg={2}>
                <GeoMetric label='AI 可引用性' value={geoEnhancement.citability_score} color='#2563EB' />
              </Col>
              <Col xs={12} sm={6} lg={2}>
                <GeoMetric label='答案块覆盖' value={geoEnhancement.ai_answer_score} color='#7C3AED' />
              </Col>
              <Col xs={12} sm={6} lg={2}>
                <GeoMetric label='实体信任' value={geoEnhancement.trust_entity_score} color='#D97706' />
              </Col>
              <Col xs={12} sm={6} lg={2}>
                <GeoMetric label='Schema 准备度' value={geoEnhancement.schema_readiness_score} color='#DB2777' />
              </Col>
              <Col xs={12} sm={6} lg={2}>
                <GeoMetric label='Crawler 准备度' value={geoEnhancement.crawler_readiness_score} color='#059669' />
              </Col>
            </Row>

            <Divider />

            <Row gutter={[16, 16]}>
              <Col xs={12} lg={6}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>增强诊断问题</div>
                {(geoEnhancement.issues || []).length === 0 ? (
                  <div style={{ color: '#999', fontSize: 13 }}>（无）</div>
                ) : (
                  <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, fontSize: 13 }}>
                    {(geoEnhancement.issues || []).map((issue, i) => (
                      <li key={i} style={{ marginBottom: 6 }}>
                        {issue}
                      </li>
                    ))}
                  </ol>
                )}
              </Col>
              <Col xs={12} lg={6}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>优先增强动作</div>
                {(geoEnhancement.fixes || []).length === 0 ? (
                  <div style={{ color: '#999', fontSize: 13 }}>（无）</div>
                ) : (
                  <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, fontSize: 13 }}>
                    {(geoEnhancement.fixes || []).map((fix, i) => (
                      <li key={i} style={{ marginBottom: 6 }}>
                        {fix}
                      </li>
                    ))}
                  </ol>
                )}
              </Col>
            </Row>
          </>
        )}
      </Card>

      <Card
        bordered={false}
        className={Style.sectionCard}
        title={
          <Space>
            <LinkIcon style={{ color: '#DC2626' }} />
            <span>联系方式治理</span>
            <Tag size='small' theme={contactRiskTheme as any} variant='light'>
              {contactGovernance?.risk_level || '未检测'}
            </Tag>
          </Space>
        }
        bodyStyle={{ padding: 20 }}
        style={{ marginTop: 16 }}
      >
        {!contactGovernance ? (
          <div style={{ color: 'var(--td-text-color-secondary)', fontSize: 13, lineHeight: 1.8 }}>
            这份报告尚未包含联系方式治理专项。重新运行基础诊断后，会自动检测官网电话、tel 链接、Schema
            telephone、llms.txt Contact 和豆包电话展示情况。
          </div>
        ) : (
          <>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={6} lg={3}>
                <GeoMetric label='治理分' value={Number(contactGovernance.score || 0)} color='#DC2626' />
              </Col>
              <Col xs={12} sm={6} lg={3}>
                <DeliveryMetric
                  title='官方电话'
                  value={contactGovernance.official_phone ? 100 : 0}
                  desc={contactGovernance.official_phone || '未维护'}
                  color='#0F766E'
                />
              </Col>
              <Col xs={12} sm={6} lg={3}>
                <DeliveryMetric
                  title='Schema 电话'
                  value={contactGovernance.schema_has_telephone ? 100 : 0}
                  desc={contactGovernance.schema_has_telephone ? '已发现 telephone' : '缺少 telephone'}
                  color='#7C3AED'
                />
              </Col>
              <Col xs={12} sm={6} lg={3}>
                <DeliveryMetric
                  title='llms Contact'
                  value={contactGovernance.llms_has_contact ? 100 : 0}
                  desc={contactGovernance.llms_has_contact ? '已包含联系方式' : '缺少 Contact 区块'}
                  color='#2563EB'
                />
              </Col>
            </Row>

            <Divider />

            <Row gutter={[16, 16]}>
              <Col xs={12} lg={6}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>联系方式风险</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <Tag theme={contactGovernance.phone_is_plain_text ? 'success' : 'danger'} variant='light'>
                    纯文本电话：{contactGovernance.phone_is_plain_text ? '有' : '缺失'}
                  </Tag>
                  <Tag theme={contactGovernance.has_tel_link ? 'success' : 'warning'} variant='light'>
                    tel 链接：{contactGovernance.has_tel_link ? '有' : '缺失'}
                  </Tag>
                  <Tag theme={contactGovernance.doubao_phone_visible ? 'success' : 'warning'} variant='light'>
                    豆包展示：{contactGovernance.doubao_phone_visible ? '有' : '未展示'}
                  </Tag>
                  <Tag theme={contactGovernance.doubao_phone_correct ? 'success' : 'warning'} variant='light'>
                    豆包准确：{contactGovernance.doubao_phone_correct ? '正确' : '待验证'}
                  </Tag>
                </div>
                <ol style={{ margin: '12px 0 0', paddingLeft: 20, lineHeight: 1.8, fontSize: 13 }}>
                  {((contactGovernance.issues || []) as string[]).slice(0, 5).map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ol>
              </Col>
              <Col xs={12} lg={6}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>优先修复</div>
                <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, fontSize: 13 }}>
                  {((contactGovernance.fixes || []) as string[]).slice(0, 5).map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ol>
              </Col>
            </Row>
          </>
        )}
      </Card>

      <Card
        bordered={false}
        className={Style.sectionCard}
        title={
          <Space>
            <LinkIcon style={{ color: '#2563EB' }} />
            <span>正式交付模块</span>
            <Tag size='small' theme='primary' variant='light'>
              技术体检 / Sitemap / 部署包
            </Tag>
          </Space>
        }
        bodyStyle={{ padding: 20 }}
        style={{ marginTop: 16 }}
      >
        {moduleLoading && !deploymentPackage ? (
          <Loading text='正在生成报告增强模块...' />
        ) : (
          <>
            <Row gutter={[16, 16]}>
              <Col xs={12} lg={4}>
                <DeliveryMetric
                  title='技术 GEO/SEO'
                  value={technicalAudit?.score || 0}
                  desc='首页技术与内容结构'
                  color='#2563EB'
                />
              </Col>
              <Col xs={12} lg={4}>
                <DeliveryMetric
                  title='Sitemap 页面'
                  value={sitemapAudit?.score || 0}
                  desc={`${sitemapAudit?.page_count || 0} 个页面已分析`}
                  color='#0F766E'
                />
              </Col>
              <Col xs={12} lg={4}>
                <DeliveryMetric
                  title='部署准备'
                  value={deploymentPackage?.overall_score || 0}
                  desc={`${deploymentPackage?.todo_count || 0} 项待部署`}
                  color='#D97706'
                />
              </Col>
            </Row>

            <Divider />

            <Row gutter={[16, 16]}>
              <Col xs={12} lg={6}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>P0/P1 部署清单</div>
                {deploymentPackage ? (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {((deploymentPackage.checklist || []) as Array<Record<string, any>>).map((item) => (
                      <div
                        key={item.title}
                        style={{ padding: 10, borderRadius: 8, background: 'var(--td-bg-color-container-hover)' }}
                      >
                        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                          <Space>
                            <Tag size='small' theme={item.priority === 'P0' ? 'danger' : 'primary'} variant='light'>
                              {item.priority}
                            </Tag>
                            <Tag size='small' theme={item.status === 'done' ? 'success' : 'warning'} variant='light'>
                              {item.status === 'done' ? '已就绪' : '待部署'}
                            </Tag>
                            <span style={{ fontWeight: 600 }}>{item.title}</span>
                          </Space>
                          <span style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>{item.owner}</span>
                        </Space>
                        <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 4 }}>
                          {item.detail}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: '#999', fontSize: 13 }}>暂未生成部署包。</div>
                )}
              </Col>
              <Col xs={12} lg={6}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>高价值页面</div>
                {sitemapAudit ? (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {((sitemapAudit.pages || []) as Array<Record<string, any>>).slice(0, 6).map((page) => (
                      <div
                        key={page.url}
                        style={{ padding: 10, borderRadius: 8, background: 'var(--td-bg-color-container-hover)' }}
                      >
                        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                          <span style={{ fontWeight: 600 }}>{page.title || page.url}</span>
                          <Tag
                            size='small'
                            theme={Number(page.ai_value_score || 0) >= 70 ? 'success' : 'warning'}
                            variant='light'
                          >
                            AI Value {page.ai_value_score || 0}
                          </Tag>
                        </Space>
                        <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 4 }}>
                          {page.url}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: '#999', fontSize: 13 }}>暂未完成 sitemap 分析。</div>
                )}
              </Col>
            </Row>
          </>
        )}
      </Card>
    </div>
  );
};

// ---------- 小组件 ----------
interface ScoreLineProps {
  label: string;
  value: number;
  reason?: string;
}
const ScoreLine: React.FC<ScoreLineProps> = ({ label, value, reason }) => {
  const color = value >= 80 ? '#10B981' : value >= 60 ? '#3B82F6' : value >= 40 ? '#F59E0B' : '#EF4444';
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 16, fontWeight: 700, color }}>{value}</span>
      </div>
      <Progress percentage={value} color={color} size='small' label={false} theme='plump' />
      {reason && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--td-text-color-secondary)',
            marginTop: 6,
            lineHeight: 1.6,
          }}
        >
          {reason}
        </div>
      )}
    </div>
  );
};

interface GeoMetricProps {
  label: string;
  value?: number;
  color: string;
}
const GeoMetric: React.FC<GeoMetricProps> = ({ label, value, color }) => {
  const safeValue = typeof value === 'number' ? value : 0;
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        background: `${color}10`,
        border: `1px solid ${color}30`,
        minHeight: 98,
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{safeValue}</div>
      <Progress percentage={safeValue} color={color} size='small' label={false} theme='line' />
    </div>
  );
};

const DeliveryMetric: React.FC<{ title: string; value: number; desc: string; color: string }> = ({
  title,
  value,
  desc,
  color,
}) => (
  <div style={{ padding: 16, borderRadius: 12, background: `${color}10`, border: `1px solid ${color}25` }}>
    <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)' }}>{title}</div>
    <div style={{ fontSize: 32, fontWeight: 700, color, marginTop: 4 }}>{value}</div>
    <Progress percentage={value} color={color} size='small' label={false} />
    <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', marginTop: 6 }}>{desc}</div>
  </div>
);

export default ReportDetail;
