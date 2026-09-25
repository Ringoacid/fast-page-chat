const GPT6_MODELS = [
  { model: 'gpt-6-luna', label: 'GPT-6 Luna' },
  { model: 'gpt-6-sol', label: 'GPT-6 Sol' },
  { model: 'gpt-6-astra', label: 'GPT-6 Astra' }
];

export function titleModelOptions(provider, catalog = [], customModels = {}, apiModel = '', savedModel = '') {
  const options = new Map();
  const add = (model, label = model) => {
    if (typeof model === 'string' && /^[\w.:-]{1,150}$/.test(model) && !options.has(model)) options.set(model, { model, label });
  };
  if (provider === 'codex') {
    add('gpt-6-luna', 'GPT-6 Luna');
    for (const item of catalog) add(item.model, item.displayName || item.model);
  } else {
    for (const item of GPT6_MODELS) add(item.model, item.label);
    add(apiModel);
    for (const model of customModels.api || []) add(model);
  }
  add(savedModel);
  return [...options.values()];
}
