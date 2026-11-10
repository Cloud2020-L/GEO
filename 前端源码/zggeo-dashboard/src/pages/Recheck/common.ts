import { AnalysisTaskRow, ReportResponse } from 'services/zggeo-api';

export const gradeColor = (score?: number) => {
  const safe = Number(score || 0);
  if (safe >= 80) return '#10B981';
  if (safe >= 60) return '#3B82F6';
  if (safe >= 40) return '#F59E0B';
  return '#EF4444';
};

export const scoreDelta = (after?: number, before?: number) => Number(after || 0) - Number(before || 0);

export const groupByDomain = (reports: ReportResponse[]) =>
  reports.reduce<Record<string, ReportResponse[]>>((acc, report) => {
    const key = report.domain || 'unknown';
    acc[key] = acc[key] || [];
    acc[key].push(report);
    return acc;
  }, {});

export const reportFromTask = (task: AnalysisTaskRow) => ({
  project_name: task.project_name,
  domain: task.domain,
  score: task.total_score || 0,
  grade: task.grade || '-',
  created_at: task.created_at,
});
