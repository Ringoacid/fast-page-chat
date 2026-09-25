export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const effortLabel = value => ({ '': '自動', none: 'なし', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '最高', max: 'Max', ultra: 'Ultra' }[value] || value);
export function effortOptions(provider, model, catalog) {
  if (provider === 'api') return EFFORTS;
  const entry = model ? catalog.find(m => m.model === model || m.id === model) : catalog.find(m => m.isDefault) || catalog[0];
  return (entry?.supportedReasoningEfforts || []).map(e => e.reasoningEffort).filter(e => EFFORTS.includes(e));
}
