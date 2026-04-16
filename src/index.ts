#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { JDLClient } from './client.js';

const apiKey = process.env.JDL_API_KEY;
if (!apiKey) {
  console.error('Error: JDL_API_KEY environment variable is required.');
  console.error('Get a free API key at https://www.jobdatalake.com');
  process.exit(1);
}

const client = new JDLClient(apiKey);

const server = new McpServer({
  name: 'jobdatalake',
  version: '1.0.0',
}, {
  capabilities: { tools: {} },
  instructions: 'JobDataLake MCP server provides access to 1M+ enriched job listings from 20,000+ companies. Use search_jobs for keyword/filter searches, get_job for full job details, get_company for company info, and find_similar_jobs for vector similarity. Each tool call uses 1 API credit.',
});

// --- search_jobs ---
server.tool(
  'search_jobs',
  'Search 1M+ job listings from 20K+ companies. Supports keyword search, AI semantic search, filters for location, salary, remote type, seniority, skills, and more.',
  {
    query: z.string().optional().describe('Keyword search (title, company, skills). Use * for all jobs.'),
    semantic_query: z.string().optional().describe('Natural language search, e.g. "backend engineer at a climate tech startup"'),
    location: z.string().optional().describe('Location filter, e.g. "Remote", "San Francisco", "Germany"'),
    remote_type: z.enum(['fully_remote', 'hybrid', 'on_site']).optional().describe('Remote work policy'),
    countries: z.string().optional().describe('Comma-separated ISO country codes, e.g. "US,GB,DE"'),
    job_function: z.enum(['eng', 'data', 'design', 'sales', 'ops', 'marketing', 'security', 'product', 'finance', 'hr', 'legal', 'other']).optional(),
    seniority: z.string().optional().describe('Comma-separated: junior, mid, senior, staff, principal'),
    employment_type: z.enum(['full_time', 'part_time', 'contract', 'internship']).optional(),
    salary_min: z.number().optional().describe('Minimum annual salary in USD'),
    salary_max: z.number().optional().describe('Maximum annual salary in USD'),
    skills: z.string().optional().describe('Comma-separated required skills, e.g. "Python,AWS,Kubernetes"'),
    company: z.string().optional().describe('Company domain filter, e.g. "stripe.com"'),
    page: z.number().optional().default(1),
    per_page: z.number().optional().default(20).describe('Results per page (max 100)'),
  },
  async (args) => {
    const params: Record<string, string> = {};
    if (args.query) params.q = args.query;
    if (args.semantic_query) params.semantic_query = args.semantic_query;
    if (args.location) params.location = args.location;
    if (args.remote_type) params.remote_type = args.remote_type;
    if (args.countries) params.countries = args.countries;
    if (args.job_function) params.job_function = args.job_function;
    if (args.seniority) params.seniority = args.seniority;
    if (args.employment_type) params.employment_type = args.employment_type;
    if (args.salary_min) params.salary_min = String(args.salary_min);
    if (args.salary_max) params.salary_max = String(args.salary_max);
    if (args.skills) params.skills = args.skills;
    if (args.company) params.domain = args.company;
    params.page = String(args.page ?? 1);
    params.per_page = String(Math.min(args.per_page ?? 20, 100));

    if (!params.q && !params.semantic_query) params.q = '*';

    try {
      const data = await client.searchJobs(params);
      const jobs = (data.jobs || []).map((j: any) => ({
        title: j.title,
        company: j.company_name,
        location: j.locations?.join(', ') || 'Not specified',
        remote: j.remote_type || 'Not specified',
        salary: j.salary_min_usd || j.salary_max_usd
          ? `$${j.salary_min_usd?.toLocaleString() || '?'} - $${j.salary_max_usd?.toLocaleString() || '?'}`
          : 'Not disclosed',
        seniority: j.seniority?.join(', ') || 'Not specified',
        skills: j.required_skills?.join(', ') || '',
        posted: j.posted_at ? new Date(j.posted_at < 1e12 ? j.posted_at * 1000 : j.posted_at).toLocaleDateString() : '',
        apply_url: j.url || '',
        job_handle: j.job_handle || '',
      }));

      return {
        content: [{
          type: 'text' as const,
          text: `Found ${data.found?.toLocaleString()} jobs (showing ${jobs.length}):\n\n${jobs.map((j: any, i: number) =>
            `${i + 1}. **${j.title}** at ${j.company}\n   ${j.location} | ${j.remote} | ${j.salary}\n   Skills: ${j.skills}\n   ${j.apply_url}`
          ).join('\n\n')}`,
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// --- get_job ---
server.tool(
  'get_job',
  'Get full details for a specific job listing including description, requirements, salary, and apply link.',
  {
    job_id: z.string().describe('Job handle or ID'),
  },
  async (args) => {
    try {
      const job = await client.getJob(args.job_id);
      const salary = job.salary_min || job.salary_max
        ? `$${job.salary_min?.toLocaleString() || '?'} - $${job.salary_max?.toLocaleString() || '?'}`
        : 'Not disclosed';

      return {
        content: [{
          type: 'text' as const,
          text: `**${job.title}** at ${job.company?.name || job.company_name || 'Unknown'}\n\n` +
            `Location: ${job.locations?.join(', ') || 'Not specified'}\n` +
            `Salary: ${salary}\n` +
            `Seniority: ${job.seniority?.join(', ') || 'Not specified'}\n` +
            `Skills: ${job.required_skills?.join(', ') || 'Not specified'}\n` +
            `Type: ${job.employment_type || 'Not specified'}\n` +
            `Apply: ${job.url || 'Not available'}\n\n` +
            `---\n\n${job.description || 'No description available.'}`,
        }],
      };
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
  async (args) => {
    try {
      const company = await client.getCompany(args.company);
      return {
        content: [{
          type: 'text' as const,
          text: `**${company.name}** (${company.domain_name})\n\n` +
            `Industry: ${company.industry?.join(', ') || 'Not specified'}\n` +
            `Size: ${company.employee_count || 'Not specified'}\n` +
            `Funding: ${company.funding || 'Not specified'}\n` +
            `Career page: ${company.career_url || 'Not available'}\n` +
            `Open jobs: ${company.job_count || 'Unknown'}`,
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// --- find_similar_jobs ---
server.tool(
  'find_similar_jobs',
  'Find jobs similar to a given job listing using AI vector similarity. Great for "more like this" discovery.',
  {
    job_id: z.string().describe('Job handle or ID to find similar jobs for'),
    per_page: z.number().optional().default(10).describe('Number of results'),
  },
  async (args) => {
    try {
      const params: Record<string, string> = {
        similar_to: args.job_id,
        per_page: String(Math.min(args.per_page ?? 10, 50)),
      };
      const data = await client.searchJobs(params);
      const jobs = (data.jobs || []).map((j: any) => ({
        title: j.title,
        company: j.company_name,
        location: j.locations?.join(', ') || '',
        salary: j.salary_min_usd || j.salary_max_usd
          ? `$${j.salary_min_usd?.toLocaleString() || '?'} - $${j.salary_max_usd?.toLocaleString() || '?'}`
          : 'Not disclosed',
        score: j.vector_score ? `${(j.vector_score * 100).toFixed(0)}% match` : '',
        job_handle: j.job_handle || '',
      }));

      return {
        content: [{
          type: 'text' as const,
          text: `Found ${jobs.length} similar jobs:\n\n${jobs.map((j: any, i: number) =>
            `${i + 1}. **${j.title}** at ${j.company} — ${j.salary} ${j.score}`
          ).join('\n')}`,
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Start server with stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
