import keytar from 'keytar';

// 历史值，勿改：本机钥匙串里已存密钥（token/API key）都挂在这个 service 名下，改了会全部失联。
const SERVICE = 'discord-agent-hub';

export async function setSecret(account: string, value: string): Promise<void> {
  await keytar.setPassword(SERVICE, account, value);
}

export async function getSecret(account: string): Promise<string | null> {
  return keytar.getPassword(SERVICE, account);
}

export async function deleteSecret(account: string): Promise<boolean> {
  return keytar.deletePassword(SERVICE, account);
}

// 命名约定：避免 account 命名冲突
export const secretAccount = {
  providerApiKey: (providerId: string) => `provider-api-key:${providerId}`,
  botDiscordToken: (botId: string) => `bot-discord-token:${botId}`,
  // 全局 web search 凭证（按 provider 区分：tavily/brave 用 key）
  webSearchKey: (provider: string) => `websearch-key:${provider}`,
  // 全局 web search 实例 URL（searxng 自建实例地址，非 secret 但同样集中存）
  webSearchUrl: (provider: string) => `websearch-url:${provider}`,
};
