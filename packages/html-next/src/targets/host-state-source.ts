/** Generated helper shared by framework targets that emit state-scoped CSS. */
export const HOST_STATE_TOKENS_SOURCE = `function hostStateTokens(name: string, value: unknown): string[] {
  const truthy = value === true || typeof value === "string" && value.length > 0 || typeof value === "number" && value !== 0 && !Number.isNaN(value);
  const tokens: string[] = [];
  if (truthy) tokens.push(name);
  if (typeof value === "string" || typeof value === "number") tokens.push(\`\${name}=\${encodeURIComponent(String(value))}\`);
  return tokens;
}`;
