# JobDataLake MCP Server

Search **1,000,000+ enriched job listings** from 20,000+ companies directly from Claude, Cursor, Windsurf, or any MCP-compatible AI tool.

## Quick Start

### Claude Code / Claude Desktop

Add to your MCP config (`~/.claude.json` or Claude Desktop settings):

```json
{
  "mcpServers": {
    "jobdatalake": {
      "command": "npx",
      "args": ["-y", "@jobdatalake/mcp-server"],
      "env": {
        "JDL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Get a free API key (1,000 credits) at [jobdatalake.com](https://www.jobdatalake.com).

### Then ask Claude:

> "Find me remote senior React jobs paying over $150k"

> "What companies are hiring the most data engineers?"

> "Show me jobs similar to this Stripe backend role"

## Tools

### `search_jobs`
Search and filter jobs with keyword search, AI semantic search, location, salary, remote type, seniority, skills, and more.

### `get_job`
Get full details for a specific job including description, requirements, salary, and apply link.

### `get_company`
Get company profile including open jobs, industry, size, and career page.

### `find_similar_jobs`
Find jobs similar to a given listing using AI vector similarity.

## Pricing

Each tool call uses 1 JDL API credit.

- **Free**: 1,000 credits on signup
- **Starter**: 1,000,000 credits — $200
- **Growth**: 2,000,000 credits — $300
- **Business**: 4,000,000 credits — $400

Credits never expire. [Get your API key](https://www.jobdatalake.com).

## Data

- 1M+ active job listings from 20,000+ companies
- 40+ ATS platforms (Greenhouse, Lever, Workday, Ashby, etc.)
- Updated hourly
- AI-enriched: salary, skills, seniority, remote policy, job function
- Sub-100ms search responses

## Support

- API issues: mg@jobdatalake.com
- GitHub: [github.com/echojobsio/jdl-mcp-server](https://github.com/echojobsio/jdl-mcp-server)
