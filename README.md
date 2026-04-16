# JobDataLake MCP Server

Search **1,000,000+ enriched job listings** from 20,000+ companies directly from Claude, Cursor, Windsurf, or any MCP-compatible AI tool.

**Free to use — no signup required.** 500 calls/day included.

## Quick Start

Add to your Claude Code or Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "jobdatalake": {
      "command": "npx",
      "args": ["-y", "@jobdatalake/mcp-server"]
    }
  }
}
```

That's it. No API key needed. Then ask:

> "Find me remote senior React jobs paying over $150k"

> "Entry level data science jobs posted this week"

> "Jobs at Anthropic paying over $200k"

### Want unlimited access?

Sign up at [jobdatalake.com](https://www.jobdatalake.com) for your own API key, then add it:

```json
{
  "mcpServers": {
    "jobdatalake": {
      "command": "npx",
      "args": ["-y", "@jobdatalake/mcp-server"],
      "env": {
        "JDL_API_KEY": "jdl_your_key_here"
      }
    }
  }
}
```

## Tools

### `search_jobs`
Search and filter jobs by keyword, skills, salary, remote type, seniority, location, date, and more.

**Filters:**
- `query` — keyword search (title, company, skills)
- `skills` — AND filter: `Python,AWS,Kubernetes` (all must match)
- `salary_min` / `salary_max` — in USD (accepts full dollars, e.g. 150000)
- `remote_type` — `fully_remote`, `hybrid`, `on_site`
- `seniority` — `Entry`, `Mid Level`, `Senior`, `Staff`, `Principal`, `Manager`, `Director`, `C Level`
- `location` — city, country, or continent (`Europe`, `Asia`, `Latin America`, `Scandinavia`, etc.)
- `countries` — ISO codes: `US,GB,DE`
- `job_function` — `eng`, `data`, `design`, `sales`, `marketing`, `product`, etc.
- `employment_type` — `full_time`, `part_time`, `contract`, `internship`
- `posted_within` — `24h`, `7d`, `30d`
- `sort_by` — `posted_at:desc`, `salary_max_usd:desc`, `salary_min_usd:asc`
- `company` — filter by domain: `stripe.com`

### `get_job`
Get full details for a specific job including description, requirements, salary, and apply link. Use the `job_handle` ID from search results.

### `get_company`
Get company profile — industry, size, funding, career page. Accepts domain (`stripe.com`) or handle.

### `get_filter_options`
Discover available filter values with job counts. Great for exploring what's in the dataset.

### `find_similar_jobs`
Find jobs similar to a given listing using AI vector similarity. Available for remote + tech jobs.

## Pricing

**Free tier (no signup):** 500 calls/day, resets daily.

**With your own API key:**
- Free: 1,000 credits on signup
- Starter: 1,000,000 credits — $200
- Growth: 2,000,000 credits — $300
- Business: 4,000,000 credits — $400

Credits never expire. [Get your API key](https://www.jobdatalake.com).

## Data

- 1M+ active job listings from 20,000+ companies
- 40+ ATS platforms (Greenhouse, Lever, Workday, Ashby, etc.)
- Updated hourly
- AI-enriched: salary (USD), skills, seniority, remote policy, job function
- Sub-100ms search responses

## Example Queries

| Query | What it does |
|-------|-------------|
| "Remote Python jobs over $150k" | Skills + salary + remote filter |
| "Jobs at Stripe" | Company filter |
| "Entry level data science" | Seniority filter |
| "New remote jobs today" | Date + remote filter |
| "React AND TypeScript jobs in Europe" | Multi-skill AND + continent |
| "Highest paying remote jobs" | Salary sort |
| "What skills are most in demand?" | Filter options tool |

## Support

- Questions: mg@jobdatalake.com
- GitHub: [github.com/echojobsio/jdl-mcp-server](https://github.com/echojobsio/jdl-mcp-server)
- Website: [jobdatalake.com](https://www.jobdatalake.com)
