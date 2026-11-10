import React, { useState } from 'react';
import { AddIcon, ArrowDownIcon, MicrophoneIcon, SearchIcon, WaveByeIcon } from 'tdesign-icons-react';

import Style from './index.module.less';

type CodeLine =
  | { blank: true }
  | {
      indent?: number;
      type: 'keyword' | 'variable' | 'string' | 'property' | 'punctuation' | 'hint';
      text: string;
    };

const codeLines: CodeLine[] = [
  { indent: 0, type: 'keyword', text: 'import ' },
  { indent: 0, type: 'variable', text: '{ useEffect, useMemo, useState } ' },
  { indent: 0, type: 'keyword', text: 'from ' },
  { indent: 0, type: 'string', text: '"react";' },
  { blank: true },
  { indent: 0, type: 'keyword', text: 'const ' },
  { indent: 0, type: 'variable', text: 'pipeline ' },
  { indent: 0, type: 'punctuation', text: '= [' },
  { indent: 1, type: 'punctuation', text: '{' },
  { indent: 2, type: 'property', text: 'key: ' },
  { indent: 2, type: 'string', text: '"diagnose",' },
  { indent: 2, type: 'property', text: 'title: ' },
  { indent: 2, type: 'string', text: '"AI可见度诊断",' },
  { indent: 2, type: 'property', text: 'detail: ' },
  { indent: 2, type: 'string', text: '"扫描品牌在 AI 搜索与答案场景中的可见状态",' },
  { indent: 2, type: 'property', text: 'output: ' },
  { indent: 2, type: 'string', text: '"已识别品牌提及率、引用率、推荐率基础盘",' },
  { indent: 1, type: 'punctuation', text: '},' },
  { indent: 1, type: 'punctuation', text: '{' },
  { indent: 2, type: 'property', text: 'key: ' },
  { indent: 2, type: 'string', text: '"strategy",' },
  { indent: 2, type: 'property', text: 'title: ' },
  { indent: 2, type: 'string', text: '"策略生成",' },
  { indent: 2, type: 'property', text: 'detail: ' },
  { indent: 2, type: 'string', text: '"自动生成结构化改进建议与增量路径",' },
  { indent: 2, type: 'property', text: 'handoff: ' },
  { indent: 2, type: 'hint', text: '"进入执行 Agent 并写入待办队列",' },
  { indent: 1, type: 'punctuation', text: '},' },
];

const pipelineSteps = [
  { title: 'Diagnose', detail: '识别品牌提及率、引用率与关键缺口页', state: 'completed' },
  { title: 'Plan', detail: '自动生成策略、页面建议与执行批次', state: 'active' },
  { title: 'Generate', detail: '批量创建问答、页面、图文与素材任务', state: 'pending' },
  { title: 'Measure', detail: '进入分发与复测闭环，持续校准结果', state: 'pending' },
];

const agentCards = [
  { name: '星枢', caption: 'Routing', value: '12 jobs', accent: 'indigo' },
  { name: '星核', caption: 'Generate', value: 'Ready', accent: 'violet' },
  { name: '星图', caption: 'Execute', value: 'Queue 04', accent: 'green' },
  { name: '星穹', caption: 'Calibrate', value: 'Watch', accent: 'muted' },
];

const navGroups = [
  ['首页', '销售漏斗', '监测诊断', '产品化报告'],
  ['内容生产', '分发执行', '回测闭环', 'Agent 矩阵引擎'],
];

const layerCards = [
  { tag: 'L2', title: '销售漏斗', desc: '留资、跟进、客户资产沉淀', status: '已上线' },
  { tag: 'L3', title: '监测诊断', desc: '品牌词、问题库、监测任务、GEO 资产', status: '已上线' },
  { tag: 'L4', title: '产品化报告', desc: '评分报告、等级分布、改进建议、导出', status: '已上线' },
  { tag: 'L5', title: '内容生产', desc: '写作任务池、Prompt 库、知识库、AI 生成', status: '进行中' },
  { tag: 'L6', title: '分发执行', desc: '账号矩阵、自媒体、媒体市场、分发记录', status: '进行中' },
  { tag: 'L7', title: '回测闭环', desc: '复测任务、效果曲线、归因分析', status: '进行中' },
];

const renderLine = (line: CodeLine, index: number) => {
  if ('blank' in line) {
    return <div key={index}>&nbsp;</div>;
  }

  return (
    <div key={index}>
      {'\u00A0'.repeat((line.indent || 0) * 2)}
      <span className={Style[line.type]}>{line.text}</span>
    </div>
  );
};

const AgentUIPreview: React.FC = () => {
  const [mode, setMode] = useState<'code' | 'preview'>('preview');

  return (
    <div className={Style.page}>
      <div className={Style.shell}>
        <div className={Style.hero}>
          <div className={Style.heroPill}>Linear 风格预览 · AI Runtime Console</div>
        </div>

        <div className={Style.thought}>已切换为冷静、精致、专业的后台预览</div>

        <section className={Style.card}>
          <header className={Style.cardHeader}>
            <div className={Style.title}>
              <div className={Style.titleMain}>ZGEO-agent-runtime-preview</div>
              <div className={Style.titleMeta}>· typescript</div>
            </div>

            <div className={Style.headerActions}>
              <button type='button' className={Style.headerAction}>
                复制
              </button>
              <button type='button' className={Style.headerAction}>
                编辑
              </button>
              <button type='button' className={Style.headerAction}>
                下载
              </button>
              <div className={Style.viewSwitch}>
                <button
                  type='button'
                  className={mode === 'code' ? Style.switchActive : Style.switchButton}
                  onClick={() => setMode('code')}
                >
                  代码
                </button>
                <button
                  type='button'
                  className={mode === 'preview' ? Style.switchActive : Style.switchButton}
                  onClick={() => setMode('preview')}
                >
                  预览
                </button>
              </div>
            </div>
          </header>

          {mode === 'preview' ? (
            <div className={Style.previewCanvas}>
              <div className={Style.previewWindow}>
                <div className={Style.previewWorkspace}>
                  <aside className={Style.sidebar}>
                    <div className={Style.sidebarBrand}>
                      <div className={Style.brandMark}>Z</div>
                      <div>
                        <div className={Style.brandName}>ZGEO 智改</div>
                        <div className={Style.brandMeta}>AI 可见度管理后台</div>
                      </div>
                    </div>

                    <div className={Style.sidebarGroups}>
                      {navGroups.map((group, index) => (
                        <div key={index} className={Style.sidebarGroup}>
                          {group.map((item) => (
                            <div key={item} className={item === '首页' ? Style.sidebarItemActive : Style.sidebarItem}>
                              {item}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>

                    <div className={Style.sidebarFoot}>
                      <div className={Style.sidebarStatus}>4 / 4 Agents healthy</div>
                      <div className={Style.sidebarVersion}>Runtime v1.0.0-preview</div>
                    </div>
                  </aside>

                  <main className={Style.workspaceMain}>
                    <div className={Style.previewTopBar}>
                      <div className={Style.previewTopLeft}>
                        <div className={Style.previewLabel}>AI OPS RUNTIME</div>
                        <div className={Style.previewHeadline}>输入一个网址，剩下的交给系统。</div>
                      </div>

                      <div className={Style.previewSearch}>
                        <SearchIcon size='18px' />
                        <span>搜索目标、报告、任务、关键词...</span>
                      </div>

                      <div className={Style.previewAvatar}>Z</div>
                    </div>

                    <div className={Style.previewHeroCard}>
                      <div className={Style.previewLaunch}>Runtime console</div>
                      <div className={Style.previewTitle}>让 AI 可见度运营像任务流一样稳定。</div>
                      <div className={Style.previewDescription}>
                        输入官网、品牌名或核心关键词，系统自动完成诊断、策略生成、内容生产、分发准备与复测优化。
                      </div>

                      <div className={Style.heroActions}>
                        <button type='button' className={Style.previewPrimaryInline}>
                          一键启动自动运作
                        </button>
                        <button type='button' className={Style.previewGhostInline}>
                          查看最新报告
                        </button>
                      </div>

                      <div className={Style.previewInputCard}>
                        <div className={Style.previewInputLabel}>TARGET INPUT</div>
                        <div className={Style.previewInputValue}>example.com</div>
                        <button type='button' className={Style.previewPrimary}>
                          启动自动优化系统
                        </button>
                        <div className={Style.previewFlow}>Diagnose → Plan → Generate → Measure</div>
                      </div>
                    </div>

                    <div className={Style.previewMetrics}>
                      <div className={Style.metricCard}>
                        <div className={Style.metricValue}>62/100</div>
                        <div className={Style.metricLabel}>当前可见度评分</div>
                      </div>
                      <div className={Style.metricCard}>
                        <div className={Style.metricValue}>0%</div>
                        <div className={Style.metricLabel}>自动执行进度</div>
                      </div>
                      <div className={Style.metricCard}>
                        <div className={Style.metricValue}>等待启动</div>
                        <div className={Style.metricLabel}>当前系统阶段</div>
                      </div>
                    </div>

                    <div className={Style.previewWorkflow}>
                      <section className={Style.workflowBoard}>
                        <div className={Style.sectionEyebrow}>FLOW STATUS</div>
                        <div className={Style.sectionTitle}>自动化队列</div>
                        <div className={Style.stepList}>
                          {pipelineSteps.map((step) => (
                            <div key={step.title} className={Style.stepRow}>
                              <div className={`${Style.stepDot} ${Style[`step${step.state}`]}`}></div>
                              <div className={Style.stepText}>
                                <div className={Style.stepTitle}>{step.title}</div>
                                <div className={Style.stepDetail}>{step.detail}</div>
                              </div>
                              <div className={`${Style.stepBadge} ${Style[`badge${step.state}`]}`}>
                                {step.state === 'completed' ? 'Done' : step.state === 'active' ? 'Live' : 'Queued'}
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>

                      <section className={Style.workflowRail}>
                        <div className={Style.sectionEyebrow}>AGENT GRID</div>
                        <div className={Style.sectionTitle}>Agent runtime</div>
                        <div className={Style.agentGrid}>
                          {agentCards.map((agent) => (
                            <div key={agent.name} className={Style.agentCard}>
                              <div className={`${Style.agentAccent} ${Style[`accent${agent.accent}`]}`}></div>
                              <div className={Style.agentName}>{agent.name}</div>
                              <div className={Style.agentCaption}>{agent.caption}</div>
                              <div className={Style.agentValue}>{agent.value}</div>
                            </div>
                          ))}
                        </div>
                        <div className={Style.workflowNote}>
                          当前模式：先生成到待发布，由人工确认后再进入个人自媒体草稿箱。
                        </div>
                      </section>
                    </div>

                    <section className={Style.layerBoard}>
                      <div className={Style.sectionEyebrow}>ZGEO LAYERS</div>
                      <div className={Style.sectionTitle}>业务层级与落地进度</div>
                      <div className={Style.layerGrid}>
                        {layerCards.map((layer) => (
                          <div key={layer.tag} className={Style.layerCard}>
                            <div className={Style.layerTop}>
                              <div className={Style.layerTag}>{layer.tag}</div>
                              <div className={Style.layerStatus}>{layer.status}</div>
                            </div>
                            <div className={Style.layerTitle}>{layer.title}</div>
                            <div className={Style.layerDesc}>{layer.desc}</div>
                          </div>
                        ))}
                      </div>
                    </section>
                  </main>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className={Style.codeArea}>
                <pre className={Style.code}>{codeLines.map(renderLine)}</pre>
              </div>

              <div className={Style.scrollHint}>
                <ArrowDownIcon size='32px' />
              </div>

              <footer className={Style.composer}>
                <button type='button' className={Style.plus} aria-label='添加'>
                  <AddIcon size='34px' />
                </button>
                <div className={Style.composerText}>有问题，尽管问</div>
                <div className={Style.voice}>
                  <MicrophoneIcon size='32px' />
                </div>
                <div className={Style.wave}>
                  <WaveByeIcon size='28px' />
                </div>
              </footer>
            </>
          )}
        </section>
      </div>
    </div>
  );
};

export default AgentUIPreview;
