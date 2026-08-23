// Shared MCP server factory. `createServer()` builds the JobDataLake MCP server
// with all tools registered but does NOT connect a transport — the stdio entry
// (index.ts, for the npm package) and the Streamable HTTP entry (http.ts, for
// the Cloud Run remote) each attach their own transport. This lets one codebase
// serve both local (Claude Desktop/CLI) and hosted (ChatGPT/Claude directory) use.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { JDLClient } from './client.js';

const MCP_FREE_KEY = 'jdl_mcp_free_1acbcbd08671a764833c21b4446ee3d6';
const apiKey = process.env.JDL_API_KEY || MCP_FREE_KEY;
const isFreeMode = apiKey === MCP_FREE_KEY;

const client = new JDLClient(apiKey);

export const CONTINENT_MAP: Record<string, string> = {
  'europe': 'DE,GB,FR,NL,ES,IT,SE,PL,IE,CH,AT,BE,DK,NO,FI,PT,CZ,RO,HU,GR',
  'asia': 'JP,CN,IN,KR,SG,TW,HK,TH,VN,PH,MY,ID',
  'latin america': 'BR,MX,AR,CO,CL,PE,UY',
  'latam': 'BR,MX,AR,CO,CL,PE,UY',
  'middle east': 'AE,IL,SA,QA,BH,KW',
  'africa': 'ZA,NG,KE,GH,EG',
  'oceania': 'AU,NZ',
  'southeast asia': 'SG,TH,PH,MY,VN,ID,MM,KH,LA',
  'scandinavia': 'SE,NO,DK,FI,IS',
  'south america': 'BR,AR,CO,CL,PE,UY,EC,VE,BO,PY',
  'nordics': 'SE,NO,DK,FI,IS',
  'apac': 'JP,CN,IN,KR,SG,TW,HK,TH,VN,PH,MY,ID,AU,NZ',
  'emea': 'DE,GB,FR,NL,ES,IT,SE,PL,IE,CH,AT,BE,DK,NO,FI,PT,CZ,RO,HU,GR,AE,IL,SA,ZA,NG,KE,EG',
};

export function formatSalary(min: number | undefined, max: number | undefined): string {
  // Filter out obviously wrong values (non-USD or absurd amounts)
  const validMin = min && min >= 10 && min <= 1000 ? min : undefined;
  const validMax = max && max >= 10 && max <= 1000 ? max : undefined;
  if (!validMin && !validMax) return 'Not disclosed';
  return `$${validMin || '?'}k - $${validMax || '?'}k`;
}

// Callers append tool output directly after this banner, so it must end with a
// separator of its own. Without the trailing newlines every free-tier response
// read "...free calls remaining todayFound 224,511 jobs (showing 1)".
function mcpWarning(remaining?: number): string {
  if (!isFreeMode || remaining === undefined) return '';
  if (remaining <= 0) return '⚠️ Daily free limit reached. Get unlimited access with your own API key at jobdatalake.com\n\n';
  if (remaining <= 50) return `⚠️ ${remaining}/500 free calls remaining today. Get unlimited access at jobdatalake.com\n\n`;
  return `📊 ${remaining}/500 free calls remaining today\n\n`;
}

export function createServer(): McpServer {
const server = new McpServer({
  name: 'jobdatalake',
  version: '1.0.0',
}, {
  capabilities: { tools: {} },
  instructions: 'JobDataLake MCP server — 1,080,000+ enriched job listings from 20,000+ companies across 40+ ATS platforms, updated hourly. Tools: search_jobs (keyword/filter search with salary, skills, location, date, seniority filters), get_job (full job detail + description), get_company (company profile), find_similar_jobs (vector similarity for remote/tech jobs), get_filter_options (discover available filter values). Location supports continents (Europe, Asia, Latin America) and ISO country codes. Salary is in thousands (150 = $150k). Free tier: 500 calls/day, unlimited with your own API key from jobdatalake.com.',
});

// --- search_jobs ---
server.tool(
  'search_jobs',
  'Search 1M+ job listings from 20K+ companies. Supports keyword search, AI semantic search, filters for location, salary, remote type, seniority, skills, and more.',
  {
    query: z.string().optional().describe('Keyword search (title, company, skills). Use * for all jobs.'),
    semantic_query: z.string().optional().describe('AI semantic search. Works best with job-title-like queries (e.g. "machine learning engineer", "senior devops"). Supported for remote + tech jobs only.'),
    location: z.string().optional().describe('Location filter, e.g. "Remote", "San Francisco", "Germany"'),
    remote_type: z.enum(['fully_remote', 'hybrid', 'on_site']).optional().describe('Remote work policy'),
    countries: z.string().optional().describe('Comma-separated ISO country codes, e.g. "US,GB,DE"'),
    job_function: z.enum(['eng', 'data', 'design', 'sales', 'ops', 'marketing', 'security', 'product', 'finance', 'hr', 'legal', 'other']).optional(),
    seniority: z.string().optional().describe('Comma-separated: Entry, Mid Level, Senior, Staff, Principal, Manager, Internship, Director, Lead, C Level'),
    employment_type: z.enum(['full_time', 'part_time', 'contract', 'internship']).optional(),
    salary_min: z.number().optional().describe('Minimum annual salary in USD'),
    salary_max: z.number().optional().describe('Maximum annual salary in USD'),
    skills: z.string().optional().describe('Comma-separated required skills, e.g. "Python,AWS,Kubernetes"'),
    company: z.string().optional().describe('Company domain filter, e.g. "stripe.com"'),
    posted_within: z.string().optional().describe('Time window: "24h", "7d", "30d" — only jobs posted within this period'),
    sort_by: z.string().optional().describe('Sort: "posted_at:desc" (newest, default), "posted_at:asc" (oldest), "salary_max_usd:desc" (highest paid), "salary_min_usd:asc" (lowest paid)'),
    page: z.number().optional().default(1),
    per_page: z.number().optional().default(20).describe('Results per page (max 100)'),
  },
  // Read-only, fetches live external data. Required by MCP hosts' review
  // (e.g. the ChatGPT app directory) and clarifies safety for every client.
  { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  async (args) => {
    const params: Record<string, string> = {};
    if (args.query) params.q = args.query;
    if (args.semantic_query) params.semantic_query = args.semantic_query;
    if (args.location) {
      // Map continent names to ISO country codes
      const continent = CONTINENT_MAP[args.location.toLowerCase()];
      if (continent) {
        params.countries = continent;
      } else {
        params.location = args.location;
      }
    }
    if (args.remote_type) params.remote_type = args.remote_type;
    if (args.countries) params.countries = args.countries;
    if (args.job_function) params.job_function = args.job_function;
    if (args.seniority) params.seniority = args.seniority;
    if (args.employment_type) params.employment_type = args.employment_type;
    // API uses salary in thousands (150 = $150K), convert if user passes full dollars
    if (args.salary_min) params.salary_min = String(args.salary_min >= 1000 ? Math.round(args.salary_min / 1000) : args.salary_min);
    if (args.salary_max) params.salary_max = String(args.salary_max >= 1000 ? Math.round(args.salary_max / 1000) : args.salary_max);
    if (args.skills) params.skills = args.skills;
    if (args.company) params.domain = args.company;
    if (args.sort_by) {
      params.sort_by = args.sort_by;
      // When sorting by salary, exclude jobs with no salary to avoid NULL values at top
      if (args.sort_by.includes('salary') && !params.salary_min) {
        params.salary_min = '1';
      }
    }
    if (args.posted_within) {
      const match = args.posted_within.match(/^(\d+)(h|d)$/);
      if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2];
        const ms = unit === 'h' ? amount * 3600 * 1000 : amount * 86400 * 1000;
        params.posted_after = String(Date.now() - ms);
      }
    }
    params.page = String(args.page ?? 1);
    params.per_page = String(Math.min(args.per_page ?? 20, 100));

    if (!params.q && !params.semantic_query) params.q = '*';

    try {
      const result = await client.searchJobs(params);
      const data = result.data;
      const jobs = (data.jobs || []).map((j: any) => ({
        title: j.title,
        company: j.company_name,
        location: j.locations?.join(', ') || 'Not specified',
        remote: j.remote_type || 'Not specified',
        salary: formatSalary(j.salary_min_usd, j.salary_max_usd),
        seniority: j.seniority?.join(', ') || 'Not specified',
        skills: (j.required_skills || []).slice(0, 15).join(', ') + (j.required_skills?.length > 15 ? '...' : ''),
        posted: j.posted_at ? new Date(j.posted_at < 1e12 ? j.posted_at * 1000 : j.posted_at).toLocaleDateString() : '',
        apply_url: j.url || '',
        job_handle: j.job_handle || '',
      }));

      let text = mcpWarning(result.mcpRemaining);
      if (jobs.length === 0) {
        text += `No jobs found matching your filters. Try:\n- Removing the salary filter (many jobs don't disclose salary)\n- Broadening the location or remote type\n- Using fewer skill filters\n- Expanding the date range`;
      } else {
        text += `Found ${data.found?.toLocaleString()} jobs (showing ${jobs.length}):\n\n${jobs.map((j: any, i: number) =>
          `${i + 1}. **${j.title}** at ${j.company}\n   ${j.location} | ${j.remote} | ${j.salary}\n   Skills: ${j.skills}\n   Apply: ${j.apply_url}\n   ID: ${j.job_handle}`
        ).join('\n\n')}`;
      }

      return { content: [{ type: 'text' as const, text }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// --- get_job ---
server.tool(
  'get_job',
  'Get full details for a specific job listing including description, requirements, salary, and apply link. Use the job_handle ID from search_jobs results.',
  {
    job_id: z.string().describe('Job handle from search results (e.g. "dropbox-senior-full-stack-software-engineer-d3f1k")'),
  },
  { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  async (args) => {
    try {
      const result = await client.getJob(args.job_id);
      const job = result.data;
      const salary = formatSalary(job.salary_min, job.salary_max);

      let text = mcpWarning(result.mcpRemaining);
      text += `**${job.title}** at ${job.company?.name || job.company_name || 'Unknown'}\n\n` +
        `Location: ${job.locations?.join(', ') || 'Not specified'}\n` +
        `Salary: ${salary}\n` +
        `Seniority: ${job.seniority?.join(', ') || 'Not specified'}\n` +
        `Skills: ${job.required_skills?.join(', ') || 'Not specified'}\n` +
        `Type: ${job.employment_type || 'Not specified'}\n` +
        `Apply: ${job.url || 'Not available'}\n\n` +
        `---\n\n${job.description || 'No description available.'}`;

      return { content: [{ type: 'text' as const, text }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// --- get_company ---
server.tool(
  'get_company',
  'Get company profile including open job count, industry, size, and career page URL.',
  {
    company: z.string().describe('Company domain (e.g. "stripe.com") or handle'),
  },
  { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  async (args) => {
    try {
      const result = await client.getCompany(args.company);
      const company = result.data;
      const companyName = company.name || company.profile_name || company.handle || 'Unknown';
      let text = mcpWarning(result.mcpRemaining);
      text += `**${companyName}** (${company.domain || company.domain_name})\n\n` +
        `Industry: ${company.industry?.join(', ') || 'Not specified'}\n` +
        `Size: ${company.employee_count || 'Not specified'}\n` +
        `Funding: ${company.funding || 'Not specified'}\n` +
        `Career page: ${company.career_url || 'Not available'}\n` +
        `Open jobs: ${company.job_count || 'Unknown'}`;

      return { content: [{ type: 'text' as const, text }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// --- find_similar_jobs ---
// The API's `similar_to` parameter only accepts a job's raw id, but every other
// tool in this server speaks in job handles (search_jobs surfaces `job_handle`,
// never the id). Passing a handle straight through always fails with an
// "embedding" error, which reads like the job has no vector when it really
// means the identifier was wrong. Resolve the handle to an id first.
const RAW_JOB_ID = /^[a-f0-9]{24}$/i;

server.tool(
  'find_similar_jobs',
  'Find jobs similar to a given job listing using AI vector similarity. Great for "more like this" discovery.',
  {
    job_id: z.string().describe('Job handle from search results (e.g. "dropbox-senior-full-stack-software-engineer-d3f1k")'),
    per_page: z.number().optional().default(10).describe('Number of results'),
  },
  { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  async (args) => {
    let similarTo = args.job_id;

    if (!RAW_JOB_ID.test(args.job_id)) {
      try {
        const lookup = await client.getJob(args.job_id);
        const id = lookup.data?.id;
        if (!id) {
          return {
            content: [{ type: 'text' as const, text: `No job found for handle "${args.job_id}". Use the job handle exactly as returned by search_jobs.` }],
            isError: true,
          };
        }
        similarTo = id;
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: `Could not look up job "${args.job_id}": ${e.message}` }],
          isError: true,
        };
      }
    }

    try {
      const params: Record<string, string> = {
        similar_to: similarTo,
        per_page: String(Math.min(args.per_page ?? 10, 50)),
      };
      const result = await client.searchJobs(params);
      const jobs = (result.data.jobs || []).map((j: any) => ({
        title: j.title,
        company: j.company_name,
        location: j.locations?.join(', ') || '',
        salary: formatSalary(j.salary_min_usd, j.salary_max_usd),
        score: j.vector_score ? `${(j.vector_score * 100).toFixed(0)}% match` : '',
        job_handle: j.job_handle || '',
      }));

      let text = mcpWarning(result.mcpRemaining);
      text += `Found ${jobs.length} similar jobs:\n\n${jobs.map((j: any, i: number) =>
        `${i + 1}. **${j.title}** at ${j.company} — ${j.salary} ${j.score}\n   ID: ${j.job_handle}`
      ).join('\n')}`;

      return { content: [{ type: 'text' as const, text }] };
    } catch (e: any) {
      // The id is known-good at this point, so an embedding error really does mean
      // this job has no vector — coverage is limited to remote and tech listings.
      if (e.message?.includes('embedding')) {
        return { content: [{ type: 'text' as const, text: 'This job doesn\'t have vector embeddings yet. Similar job search is only available for remote and tech jobs. Try using search_jobs with similar keywords instead.' }] };
      }
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);


// --- get_filter_options ---
server.tool(
  'get_filter_options',
  'Get available filter values (seniority levels, job functions, skills, etc.) with job counts. Useful for discovering what values to use in search filters.',
  {
    facets: z.string().optional().default('seniority,job_function,remote_type,employment_type,required_skills').describe('Comma-separated facet fields to retrieve'),
  },
  { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  async (args) => {
    try {
      const result = await client.searchJobs({ q: '*', per_page: '0', facets: args.facets ?? 'seniority,job_function,remote_type,employment_type,required_skills' });
      const facets = result.data.facets || {};
      let text = mcpWarning(result.mcpRemaining);
      text += 'Available filter values:\n';
      for (const [field, values] of Object.entries(facets)) {
        text += `\n**${field}:**\n`;
        for (const v of values as any[]) {
          text += `  - ${v.value} (${v.count.toLocaleString()} jobs)\n`;
        }
      }
      return { content: [{ type: 'text' as const, text }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

  return server;
}
