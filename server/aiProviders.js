import * as deepseek from './deepseek.js'
import * as openai from './openai.js'

export const DEFAULT_AI_PROVIDER = 'deepseek'

const providers = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    keyName: 'DEEPSEEK_API_KEY',
    module: deepseek,
  },
  openai: {
    id: 'openai',
    label: 'GPT-5.5',
    keyName: 'OPENAI_API_KEY',
    module: openai,
  },
}

export function normalizeAiProviderId(value) {
  const id = String(value || DEFAULT_AI_PROVIDER).toLowerCase()
  return providers[id] ? id : DEFAULT_AI_PROVIDER
}

export function getAiProvider(value) {
  return providers[normalizeAiProviderId(value)]
}

export function listAiProviders() {
  return Object.values(providers).map((provider) => ({
    id: provider.id,
    label: provider.label,
    configured: provider.module.hasAiKey(),
    model: provider.module.getAiModelName(),
    lowCostModelSelected: provider.module.isLowCostModelSelected(),
  }))
}

export function getDefaultAiProviderInfo() {
  const provider = getAiProvider(DEFAULT_AI_PROVIDER)
  return providerToInfo(provider)
}

export function providerToInfo(provider) {
  return {
    id: provider.id,
    label: provider.label,
    configured: provider.module.hasAiKey(),
    model: provider.module.getAiModelName(),
    lowCostModelSelected: provider.module.isLowCostModelSelected(),
  }
}

export function assertAiProviderReady(provider) {
  if (!provider.module.hasAiKey()) {
    throw new Error(`还没有配置 ${provider.keyName}，暂时无法调用 ${provider.label}。`)
  }
  if (!provider.module.isLowCostModelSelected()) {
    throw new Error(`当前 ${provider.label} 模型 ${provider.module.getAiModelName()} 不在保护列表中，请检查环境变量。`)
  }
}
