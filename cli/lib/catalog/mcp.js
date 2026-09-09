// First-party hosted servers. Remote OAuth belongs to the selected MCP client.
// Reviewed against provider documentation on 2026-09-09.
export const MCP_SERVERS = [
  { id: 'notion', name: 'Notion', category: 'Knowledge', description: 'Pages, databases, and workspace knowledge', url: 'https://mcp.notion.com/mcp', docs: 'https://developers.notion.com/guides/mcp/get-started-with-mcp' },
  { id: 'linear', name: 'Linear', category: 'Planning', description: 'Issues, projects, and comments', url: 'https://mcp.linear.app/mcp', docs: 'https://linear.app/docs/mcp' },
  { id: 'atlassian', name: 'Atlassian', category: 'Planning', description: 'Jira and Confluence in Atlassian Cloud', url: 'https://mcp.atlassian.com/v2/mcp', docs: 'https://atlassian.github.io/atlassian-mcp-server/', note: 'Organization access policies apply; Jira Service Management requires separate API-token configuration.' },
  { id: 'figma', name: 'Figma', category: 'Design', description: 'Design context and supported canvas operations', url: 'https://mcp.figma.com/mcp', docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/', note: 'Figma permits supported clients, including Claude Code, Codex, and Cursor; capabilities depend on the client.' },
  { id: 'sentry', name: 'Sentry', category: 'Observability', description: 'Errors, performance, and issue investigation', url: 'https://mcp.sentry.dev/mcp', docs: 'https://mcp.sentry.dev/' },
  { id: 'stripe', name: 'Stripe', category: 'Payments', description: 'Stripe account data and payment integration tools', url: 'https://mcp.stripe.com', docs: 'https://docs.stripe.com/mcp', note: 'Choose the intended account and sandbox or live environment during authorization.' },
  { id: 'neon', name: 'Neon', category: 'Databases', description: 'Postgres projects, branches, queries, and migrations', url: 'https://mcp.neon.tech/mcp', docs: 'https://neon.com/docs/ai/neon-mcp-server', note: 'Neon recommends its MCP server for development and testing.' },
  { id: 'supabase', name: 'Supabase', category: 'Databases', description: 'Projects, SQL, functions, and development tools', url: 'https://mcp.supabase.com/mcp', docs: 'https://supabase.com/docs/guides/ai-tools/mcp', note: 'The default endpoint exposes your authorized organization; provider docs explain project and read-only scoping.' },
  { id: 'vercel', name: 'Vercel', category: 'Deployment', description: 'Projects, deployments, logs, and analytics', url: 'https://mcp.vercel.com', docs: 'https://vercel.com/docs/agent-resources/vercel-mcp', note: 'Vercel permits supported clients, including Claude Code, Codex, and Cursor.' },
];

export function getMcpServers(ids) {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  return unique.map((id) => {
    const server = MCP_SERVERS.find((entry) => entry.id === id);
    if (!server) throw new Error(`unknown MCP server "${id}". Run "suped mcp list" for available servers.`);
    return server;
  });
}
